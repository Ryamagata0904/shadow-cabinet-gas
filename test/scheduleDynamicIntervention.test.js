const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const promptsJs = fs.readFileSync(path.join(root, 'Prompts.ts'), 'utf8');
const codeJs = fs.readFileSync(path.join(root, 'Code.ts'), 'utf8');

function frozenDate(nowIso) {
  const RealDate = Date;
  function FrozenDate() {
    if (arguments.length === 0) {
      return new RealDate(nowIso);
    }
    return new RealDate(...arguments);
  }
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.now = function () {
    return new RealDate(nowIso).getTime();
  };
  FrozenDate.prototype = RealDate.prototype;
  return FrozenDate;
}

function formatDate(date, timeZone, format) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(date).forEach(function (part) {
    parts[part.type] = part.value;
  });
  const ymd = parts.year + '-' + parts.month + '-' + parts.day;
  if (format === 'yyyy-MM-dd') return ymd;
  return ymd + ' ' + parts.hour + ':' + parts.minute + ' (' + parts.weekday + ')';
}

function loadGas(options) {
  const created = [];
  const deleted = [];
  const fetches = [];
  const projectTriggers = (options.triggers || []).map(function (trigger) {
    return {
      getUniqueId: function () { return trigger.id; },
      getHandlerFunction: function () { return trigger.handler; }
    };
  });

  const sandbox = {
    console: console,
    created: created,
    deleted: deleted,
    fetches: fetches,
    Date: frozenDate(options.nowIso),
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) {
            if (key === 'GEMINI_API_KEY') return 'test-key';
            return null;
          },
          setProperty: function () {}
        };
      }
    },
    Utilities: {
      formatDate: formatDate
    },
    ScriptApp: {
      getProjectTriggers: function () {
        return projectTriggers.slice();
      },
      deleteTrigger: function (trigger) {
        deleted.push(trigger.getUniqueId());
      },
      newTrigger: function (handlerName) {
        return {
          timeBased: function () {
            return {
              at: function (when) {
                return {
                  create: function () {
                    created.push({ handlerName: handlerName, at: when });
                  }
                };
              }
            };
          }
        };
      }
    },
    UrlFetchApp: {
      fetch: function (url, request) {
        fetches.push({
          url: url,
          body: JSON.parse(request.payload)
        });
        return {
          getContentText: function () {
            return JSON.stringify({
              candidates: [{ content: { parts: [{ text: options.geminiText }] } }]
            });
          },
          getResponseCode: function () { return 200; }
        };
      }
    },
    DriveApp: {},
    DocumentApp: {}
  };

  vm.createContext(sandbox);
  vm.runInContext(promptsJs, sandbox, { filename: 'Prompts.ts' });
  vm.runInContext(codeJs, sandbox, { filename: 'Code.ts' });
  return sandbox;
}

function assertClock(actual, hour, minute, label) {
  assert.equal(actual.hour, hour);
  assert.equal(actual.minute, minute);
  assert.equal(actual.label, label);
}

test('HH:mm だけを抜き、番号や前置きや「1」単体は時刻にしない', function () {
  const gas = loadGas({ nowIso: '2026-11-11T08:00:00+09:00', geminiText: '19:30' });

  assertClock(gas.parseInterventionClock('19:30'), 19, 30, '19:30');
  assertClock(gas.parseInterventionClock('1. 19:30'), 19, 30, '19:30');
  assertClock(gas.parseInterventionClock('最適時刻は 08:05 です'), 8, 5, '08:05');
  assertClock(gas.parseInterventionClock('１９：３０'), 19, 30, '19:30');
  assert.equal(gas.parseInterventionClock('1'), null);
  assert.equal(gas.parseInterventionClock('9:30'), null);
  assert.equal(gas.parseInterventionClock('24:00'), null);
  assert.equal(gas.parseInterventionClock('19:60'), null);
  assert.equal(gas.parseInterventionClock(''), null);
});

test('Gemini が「1」だけ返しても 19:30 のトリガーを作る', function () {
  const gas = loadGas({
    nowIso: '2026-11-11T08:00:00+09:00',
    geminiText: '1',
    triggers: [{ id: 'stale-intervention', handler: 'executeDynamicIntervention' }]
  });

  gas.scheduleDynamicIntervention();

  const prompt = gas.fetches[0].body.contents[0].parts[0].text;
  assert.match(prompt, /半角5文字のみ/);
  assert.match(prompt, /前置き、説明、理由、箇条書き、番号/);
  assert.equal(gas.fetches[0].body.generationConfig.maxOutputTokens, 1024);
  assert.equal(gas.fetches[0].body.generationConfig.temperature, 0);

  assert.deepEqual(gas.deleted, ['stale-intervention']);
  assert.equal(gas.created.length, 1);
  assert.equal(gas.created[0].handlerName, 'executeDynamicIntervention');
  assert.equal(gas.created[0].at.toISOString(), '2026-11-11T10:30:00.000Z');
});

test('箇条書き「1. 19:30」からは 19:30 を採用する', function () {
  const gas = loadGas({
    nowIso: '2026-11-11T08:00:00+09:00',
    geminiText: '1. 19:30'
  });

  gas.scheduleDynamicIntervention();

  assert.equal(gas.created.length, 1);
  assert.equal(gas.created[0].at.toISOString(), '2026-11-11T10:30:00.000Z');
});

test('未来の HH:mm はその時刻でトリガーを作る', function () {
  const gas = loadGas({
    nowIso: '2026-11-11T08:00:00+09:00',
    geminiText: '15:15'
  });

  gas.scheduleDynamicIntervention();

  assert.equal(gas.created[0].at.toISOString(), '2026-11-11T06:15:00.000Z');
});

test('過去時刻は 19:30 に倒す。19:30 も過ぎていれば翌日に設定する', function () {
  const morning = loadGas({
    nowIso: '2026-11-11T08:00:00+09:00',
    geminiText: '07:00'
  });
  morning.scheduleDynamicIntervention();
  assert.equal(morning.created[0].at.toISOString(), '2026-11-11T10:30:00.000Z');

  const night = loadGas({
    nowIso: '2026-11-11T21:00:00+09:00',
    geminiText: '15:15'
  });
  night.scheduleDynamicIntervention();
  assert.equal(night.created[0].at.toISOString(), '2026-11-12T10:30:00.000Z');
});
