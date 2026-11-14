const GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';
const VITAL_FILE_NAME = 'ShadowCabinet_VitalLogs';
const DAILY_SHEET_NAME = 'DailyVitals';
const INTRADAY_SHEET_NAME = 'IntradayVitals';

/**
 * Garmin Personal API キーから 24時間有効なアクセストークンを取得（キャッシュ利用）
 */
function getGarminAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get('GARMIN_ACCESS_TOKEN');
  if (cachedToken) return cachedToken;

  const apiKey = PropertiesService.getScriptProperties().getProperty('GARMIN_PERSONAL_API_KEY');
  if (!apiKey) {
    throw new Error('スクリプトプロパティ GARMIN_PERSONAL_API_KEY が未設定です');
  }

  const res = UrlFetchApp.fetch(
    `${GARMIN_BASE_URL}/personalapitoken-service/personal-api/personal-api-key/token`,
    {
      method: 'post',
      headers: { Authorization: `ApiKey ${apiKey}` },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    throw new Error(`Garmin トークン取得失敗 (${res.getResponseCode()}): ${res.getContentText()}`);
  }

  let token = res.getContentText().trim();
  if (token.startsWith('{')) {
    const parsed = JSON.parse(token);
    token = parsed.access_token || parsed.token || token;
  } else {
    token = token.replace(/^"|"$/g, '');
  }

  cache.put('GARMIN_ACCESS_TOKEN', token, 82800);
  return token;
}

/**
 * チャットログと同じフォルダにある保存先スプレッドシートを取得（なければ自動作成）
 */
function getVitalSpreadsheet_() {
  const logFile = DriveApp.getFileById(LOG_DOC_ID);
  const parents = logFile.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  const files = folder.searchFiles(`title = "${VITAL_FILE_NAME}" and mimeType = "${MimeType.GOOGLE_SHEETS}"`);

  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(VITAL_FILE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    const defaultSheet = ss.getActiveSheet();
    defaultSheet.setName(DAILY_SHEET_NAME);
  }
  return ss;
}

/**
 * 指定名のシートを取得（なければヘッダー付きで作成）
 */
function getOrCreateSheet_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Garmin API 呼び出し用ヘルパー
 */
function fetchGarminJson_(path, token) {
  const res = UrlFetchApp.fetch(`${GARMIN_BASE_URL}${path}`, {
    method: 'get',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    console.warn(`Garmin API警告 [${res.getResponseCode()}] ${path}: ${res.getContentText().slice(0, 150)}`);
    return null;
  }
  return JSON.parse(res.getContentText());
}

/**
 * 【定期実行用】日次サマリー（DailyVitals）と時間帯別ログ（IntradayVitals）の両方を同期
 */
function syncGarminVitalsToSheet() {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 直近3日分を取得

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const updatedAt = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  const dailyMap = {};
  const ensureDay = function(dateStr) {
    if (!dateStr) return null;
    if (!dailyMap[dateStr]) {
      dailyMap[dateStr] = {
        date: dateStr,
        hrvLastNight: '',
        hrvStatus: '',
        bbMax: '',
        bbLatest: '',
        stressAvg: '',
        steps: '',
        sleepHours: ''
      };
    }
    return dailyMap[dateStr];
  };

  // 時間帯別 Body Battery マップ（キー: "yyyy-MM-dd HH:00"）
  const hourlyBbMap = {};

  // 1. HRV（心拍変動）
  const hrvData = fetchGarminJson_(`/hrv-service/hrv/daily/${startDate}/${endDate}`, token);
  if (hrvData && Array.isArray(hrvData.hrvSummaries)) {
    for (const item of hrvData.hrvSummaries) {
      const rec = ensureDay(item.calendarDate);
      if (!rec) continue;
      if (item.lastNightAvg !== null && item.lastNightAvg !== undefined) {
        rec.hrvLastNight = item.lastNightAvg;
      }
      if (item.status) {
        rec.hrvStatus = item.status;
      }
    }
  }

  // 2. Body Battery（日次ピーク＋時間ごとの推移配列を抽出）
  const bbData = fetchGarminJson_(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${startDate}&endDate=${endDate}`, token);
  if (Array.isArray(bbData)) {
    for (const item of bbData) {
      const rec = ensureDay(item.date);
      if (Array.isArray(item.bodyBatteryValuesArray) && item.bodyBatteryValuesArray.length > 0) {
        const levels = [];
        for (const pair of item.bodyBatteryValuesArray) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const ts = Number(pair[0]);
          const val = Number(pair[1]);
          if (isNaN(ts) || isNaN(val)) continue;

          levels.push(val);

          // タイムスタンプから JST の日付と「時（00〜23）」を割り出して時間帯別マップへ格納
          const dt = new Date(ts);
          const dStr = Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM-dd');
          const hStr = Utilities.formatDate(dt, 'Asia/Tokyo', 'HH');
          const key = `${dStr} ${hStr}:00`;
          hourlyBbMap[key] = {
            dateHour: key,
            date: dStr,
            hour: Number(hStr),
            bbLevel: val
          };
        }

        if (rec && levels.length > 0) {
          rec.bbMax = Math.max.apply(null, levels);
          rec.bbLatest = levels[levels.length - 1];
        }
      }
    }
  }

  // 3. ストレスレベル
  const stressData = fetchGarminJson_(`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`, token);
  if (Array.isArray(stressData)) {
    for (const item of stressData) {
      const rec = ensureDay(item.calendarDate);
      if (!rec || !item.values) continue;
      if (item.values.overallStressLevel !== null && item.values.overallStressLevel !== undefined && item.values.overallStressLevel >= 0) {
        rec.stressAvg = item.values.overallStressLevel;
      }
    }
  }

  // 4. 日次サマリー（歩数）
  const summaryData = fetchGarminJson_(`/usersummary-service/v2/dailysummaries?startDate=${startDate}&endDate=${endDate}`, token);
  if (summaryData && Array.isArray(summaryData.data)) {
    for (const item of summaryData.data) {
      const rec = ensureDay(item.calendarDate);
      if (!rec) continue;
      if (item.movement && item.movement.steps && item.movement.steps.value !== undefined) {
        rec.steps = item.movement.steps.value;
      }
    }
  }

  // 5. 睡眠サマリー
  const sleepData = fetchGarminJson_(`/sleep-service/sleep/dailySleepSummariesByDate?startDate=${startDate}&endDate=${endDate}`, token);
  if (Array.isArray(sleepData)) {
    for (const item of sleepData) {
      if (!item.calendarDate || !item.sleepTimeSeconds) continue;
      const rec = ensureDay(item.calendarDate);
      if (!rec) continue;
      rec.sleepHours = Math.round((Number(item.sleepTimeSeconds) / 3600) * 10) / 10;
    }
  }

  const ss = getVitalSpreadsheet_();

  // --- A. DailyVitals（1日1行）への Upsert ---
  const dailySheet = getOrCreateSheet_(ss, DAILY_SHEET_NAME, [
    'date', 'hrv_last_night', 'hrv_status', 'bb_max', 'bb_latest', 'stress_avg', 'steps', 'sleep_hours', 'updated_at'
  ]);
  const dailyLastRow = dailySheet.getLastRow();
  const dailyRowMap = {};
  if (dailyLastRow >= 2) {
    const existingDates = dailySheet.getRange(2, 1, dailyLastRow - 1, 1).getValues();
    for (let i = 0; i < existingDates.length; i++) {
      const d = existingDates[i][0] instanceof Date
        ? Utilities.formatDate(existingDates[i][0], 'Asia/Tokyo', 'yyyy-MM-dd')
        : String(existingDates[i][0]);
      dailyRowMap[d] = i + 2;
    }
  }

  const dates = Object.keys(dailyMap).sort();
  for (const d of dates) {
    const rec = dailyMap[d];
    const rowValues = [
      rec.date, rec.hrvLastNight, rec.hrvStatus, rec.bbMax, rec.bbLatest, rec.stressAvg, rec.steps, rec.sleepHours, updatedAt
    ];
    if (dailyRowMap[d]) {
      dailySheet.getRange(dailyRowMap[d], 1, 1, 9).setValues([rowValues]);
    } else {
      dailySheet.appendRow(rowValues);
    }
  }
  if (dailySheet.getLastRow() >= 3) {
    dailySheet.getRange(2, 1, dailySheet.getLastRow() - 1, 9).sort({ column: 1, ascending: true });
  }

  // --- B. IntradayVitals（1時間1行）への Upsert ---
  const intradaySheet = getOrCreateSheet_(ss, INTRADAY_SHEET_NAME, [
    'date_hour', 'date', 'hour', 'bb_level', 'updated_at'
  ]);
  const intraLastRow = intradaySheet.getLastRow();
  const intraRowMap = {};
  if (intraLastRow >= 2) {
    const existingKeys = intradaySheet.getRange(2, 1, intraLastRow - 1, 1).getValues();
    for (let i = 0; i < existingKeys.length; i++) {
      intraRowMap[String(existingKeys[i][0])] = i + 2;
    }
  }

  const hourKeys = Object.keys(hourlyBbMap).sort();
  let intraAdded = 0;
  for (const k of hourKeys) {
    const hRec = hourlyBbMap[k];
    const rowValues = [hRec.dateHour, hRec.date, hRec.hour, hRec.bbLevel, updatedAt];
    if (intraRowMap[k]) {
      intradaySheet.getRange(intraRowMap[k], 1, 1, 5).setValues([rowValues]);
    } else {
      intradaySheet.appendRow(rowValues);
      intraAdded++;
    }
  }
  if (intradaySheet.getLastRow() >= 3) {
    intradaySheet.getRange(2, 1, intradaySheet.getLastRow() - 1, 5).sort({ column: 1, ascending: true });
  }

  console.log(`✅ バイタル同期完了（日次: ${dates.length}日分 / 時間帯別新規: ${intraAdded}件）`);
}

/**
 * 【Geminiプロンプト注入用】過去30日基準値＋今日の時間推移＋時間帯別の弱点分析を整形して返す
 */
function getVitalSummaryForPrompt(recentDays) {
  const days = recentDays || 5;
  const ss = getVitalSpreadsheet_();
  const dailySheet = ss.getSheetByName(DAILY_SHEET_NAME);
  if (!dailySheet || dailySheet.getLastRow() < 2) {
    return '【バイタルデータ（Garmin）】記録なし';
  }

  const rows = dailySheet.getRange(2, 1, dailySheet.getLastRow() - 1, 9).getValues();
  const now = new Date();
  const todayStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  let sumHrv = 0, cntHrv = 0;
  let sumBbMax = 0, cntBbMax = 0;
  let sumStress = 0, cntStress = 0;
  let sumSteps = 0, cntSteps = 0;

  const recentLines = [];
  let latest = null;

  for (const row of rows) {
    const dateStr = row[0] instanceof Date
      ? Utilities.formatDate(row[0], 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(row[0]);
    const recDate = new Date(dateStr);
    if (isNaN(recDate.getTime())) continue;

    const hrv = row[1] !== '' ? Number(row[1]) : null;
    const hrvStatus = String(row[2] || '');
    const bbMax = row[3] !== '' ? Number(row[3]) : null;
    const bbLatest = row[4] !== '' ? Number(row[4]) : null;
    const stress = row[5] !== '' ? Number(row[5]) : null;
    const steps = row[6] !== '' ? Number(row[6]) : null;
    const sleep = row[7] !== '' ? Number(row[7]) : null;

    if (recDate >= thirtyDaysAgo) {
      if (hrv !== null && !isNaN(hrv)) { sumHrv += hrv; cntHrv++; }
      if (bbMax !== null && !isNaN(bbMax)) { sumBbMax += bbMax; cntBbMax++; }
      if (stress !== null && !isNaN(stress)) { sumStress += stress; cntStress++; }
      if (steps !== null && !isNaN(steps)) { sumSteps += steps; cntSteps++; }
    }

    if (recDate >= recentCutoff) {
      const parts = [];
      if (bbMax !== null && bbLatest !== null) parts.push(`BB:${bbMax}→${bbLatest}`);
      if (hrv !== null) parts.push(`HRV:${hrv}(${hrvStatus || '-'})`);
      if (stress !== null) parts.push(`ストレス:${stress}`);
      if (sleep !== null) parts.push(`睡眠:${sleep}h`);
      if (steps !== null) parts.push(`歩数:${steps}`);
      if (parts.length > 0) {
        recentLines.push(`  - ${dateStr}: ${parts.join(' / ')}`);
      }
    }

    latest = { dateStr, hrv, hrvStatus, bbMax, bbLatest, stress, steps, sleep };
  }

  if (!latest) return '【バイタルデータ（Garmin）】有効なデータなし';

  const lines = ['【バイタルデータ（Garmin 体調ログ）】'];

  // 1. 過去30日基準値
  const baseParts = [];
  if (cntHrv > 0) baseParts.push(`HRV ${Math.round(sumHrv / cntHrv)}ms`);
  if (cntBbMax > 0) baseParts.push(`朝BodyBattery ${Math.round(sumBbMax / cntBbMax)}`);
  if (cntStress > 0) baseParts.push(`平均ストレス ${Math.round(sumStress / cntStress)}`);
  if (cntSteps > 0) baseParts.push(`歩数 ${Math.round(sumSteps / cntSteps)}歩`);
  if (baseParts.length > 0) {
    lines.push(`- 基準値（過去30日平均）: ${baseParts.join(' / ')}`);
  }

  // 2. 最新日の状態
  const latestParts = [];
  if (latest.bbMax !== null && latest.bbLatest !== null) latestParts.push(`BodyBattery ${latest.bbMax}→${latest.bbLatest}`);
  if (latest.hrv !== null) latestParts.push(`HRV ${latest.hrv}ms (${latest.hrvStatus || '-'})`);
  if (latest.stress !== null) latestParts.push(`ストレス ${latest.stress}`);
  if (latest.sleep !== null) latestParts.push(`睡眠 ${latest.sleep}時間`);
  if (latest.steps !== null) latestParts.push(`歩数 ${latest.steps}歩`);

  const isFatigued =
    (latest.bbLatest !== null && latest.bbLatest <= 20) ||
    (latest.bbMax !== null && latest.bbMax <= 50) ||
    (latest.hrvStatus === 'LOW' || latest.hrvStatus === 'POOR' || latest.hrvStatus === 'UNBALANCED') ||
    (latest.stress !== null && latest.stress >= 45);

  const conditionTag = isFatigued
    ? ' ※疲労・エネルギー低下サインあり（回復・休息優先）'
    : ' ※コンディション良好・平常範囲内';

  lines.push(`- 最新（${latest.dateStr}）: ${latestParts.join(' / ')}${conditionTag}`);

  // 3. 時間帯別データの集計（今日の時間推移 ＋ 過去14日の時間帯別消耗パターン）
  const intraSheet = ss.getSheetByName(INTRADAY_SHEET_NAME);
  if (intraSheet && intraSheet.getLastRow() >= 2) {
    const intraRows = intraSheet.getRange(2, 1, intraSheet.getLastRow() - 1, 4).getValues();
    const todayHours = [];

    // 5つの時間帯ブロックで過去14日の平均残量を集計
    const blocks = [
      { label: '朝(07-09時)', min: 7, max: 9, sum: 0, cnt: 0 },
      { label: '昼(11-13時)', min: 11, max: 13, sum: 0, cnt: 0 },
      { label: '午後(14-16時)', min: 14, max: 16, sum: 0, cnt: 0 },
      { label: '夕方(17-19時)', min: 17, max: 19, sum: 0, cnt: 0 },
      { label: '夜(20-22時)', min: 20, max: 22, sum: 0, cnt: 0 }
    ];

    for (const r of intraRows) {
      const dStr = r[1] instanceof Date
        ? Utilities.formatDate(r[1], 'Asia/Tokyo', 'yyyy-MM-dd')
        : String(r[1]);
      const hr = Number(r[2]);
      const bb = Number(r[3]);
      if (isNaN(hr) || isNaN(bb)) continue;

      if (dStr === todayStr) {
        const hh = hr < 10 ? `0${hr}` : `${hr}`;
        todayHours.push(`${hh}時:${bb}`);
      }

      const dObj = new Date(dStr);
      if (!isNaN(dObj.getTime()) && dObj >= fourteenDaysAgo) {
        for (const b of blocks) {
          if (hr >= b.min && hr <= b.max) {
            b.sum += bb;
            b.cnt++;
          }
        }
      }
    }

    if (todayHours.length > 0) {
      lines.push(`- 今日のBody Battery推移: ${todayHours.join(' → ')}`);
    }

    // 時間帯別の平均と「最も消耗が激しい区間」の特定
    const validBlocks = blocks.filter(function(b) { return b.cnt > 0; }).map(function(b) {
      return { label: b.label, avg: Math.round(b.sum / b.cnt) };
    });

    if (validBlocks.length >= 2) {
      let maxDrop = 0;
      let maxDropLabel = '';
      for (let i = 1; i < validBlocks.length; i++) {
        const drop = validBlocks[i - 1].avg - validBlocks[i].avg;
        if (drop > maxDrop) {
          maxDrop = drop;
          maxDropLabel = `${validBlocks[i - 1].label}→${validBlocks[i].label} (-${drop})`;
        }
      }
      const trendStr = validBlocks.map(function(b) { return `${b.label}:${b.avg}`; }).join(' → ');
      const alertStr = maxDrop > 0 ? `（※最も消耗が激しい区間: ${maxDropLabel}）` : '';
      lines.push(`- 時間帯別の消耗傾向（過去14日平均）: ${trendStr} ${alertStr}`);
    }
  }

  if (recentLines.length > 0) {
    lines.push(`- 直近${days}日間の日次推移:\n${recentLines.join('\n')}`);
  }

  return lines.join('\n');
}
function testGarminHealthEndpoints() {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');

  const endpoints = [
    { name: 'HRV（心拍変動）', path: `/hrv-service/hrv/daily/${startDate}/${endDate}` },
    { name: 'ストレスレベル', path: `/usersummary-service/stats/stress/daily/${startDate}/${endDate}` },
    { name: '日次サマリー', path: `/usersummary-service/v2/dailysummaries?startDate=${startDate}&endDate=${endDate}` },
    { name: '睡眠サマリー', path: `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${startDate}&endDate=${endDate}` },
    { name: 'Body Battery', path: `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${startDate}&endDate=${endDate}` }
  ];

  for (const ep of endpoints) {
    const res = UrlFetchApp.fetch(`${GARMIN_BASE_URL}${ep.path}`, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    console.log(`=== ${ep.name} [${code}] ===`);
    if (code === 200) {
      console.log(res.getContentText().slice(0, 600));
    } else {
      console.log('エラー内容:', res.getContentText().slice(0, 200));
    }
  }
}