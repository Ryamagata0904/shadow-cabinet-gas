const GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';
const VITAL_FILE_NAME = 'ShadowCabinet_VitalLogs';
const VITAL_SHEET_NAME = 'DailyVitals';

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
 * チャットログと同じフォルダにある保存先シートを取得（なければ自動作成）
 */
function getVitalSheet_() {
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

    const sheet = ss.getActiveSheet();
    sheet.setName(VITAL_SHEET_NAME);
    sheet.appendRow([
      'date',
      'hrv_last_night',
      'hrv_status',
      'bb_max',
      'bb_latest',
      'stress_avg',
      'steps',
      'sleep_hours',
      'updated_at'
    ]);
    sheet.setFrozenRows(1);
  }

  let targetSheet = ss.getSheetByName(VITAL_SHEET_NAME);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(VITAL_SHEET_NAME);
    targetSheet.appendRow([
      'date',
      'hrv_last_night',
      'hrv_status',
      'bb_max',
      'bb_latest',
      'stress_avg',
      'steps',
      'sleep_hours',
      'updated_at'
    ]);
    targetSheet.setFrozenRows(1);
  }
  return targetSheet;
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
 * 【日次バッチ用】Garmin から直近3日分のバイタル（HRV/BodyBattery/ストレス/歩数/睡眠）を取得しシートを更新
 */
function syncGarminVitalsToSheet() {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 直近3日分を取得

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const updatedAt = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  // 日付ごとのデータをまとめるマップ
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

  // 2. Body Battery
  const bbData = fetchGarminJson_(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${startDate}&endDate=${endDate}`, token);
  if (Array.isArray(bbData)) {
    for (const item of bbData) {
      const rec = ensureDay(item.date);
      if (!rec) continue;
      if (Array.isArray(item.bodyBatteryValuesArray) && item.bodyBatteryValuesArray.length > 0) {
        const levels = item.bodyBatteryValuesArray
          .map(function(pair) { return Array.isArray(pair) ? Number(pair[1]) : NaN; })
          .filter(function(val) { return !isNaN(val); });
        if (levels.length > 0) {
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

  const dates = Object.keys(dailyMap).sort();
  if (dates.length === 0) {
    console.log('同期対象のバイタルデータはありませんでした。');
    return;
  }

  // シートへ Upsert（既存日付は上書き、新規日付は追記）
  const sheet = getVitalSheet_();
  const lastRow = sheet.getLastRow();
  const rowIndexByDate = {};

  if (lastRow >= 2) {
    const existingDates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < existingDates.length; i++) {
      const d = existingDates[i][0] instanceof Date
        ? Utilities.formatDate(existingDates[i][0], 'Asia/Tokyo', 'yyyy-MM-dd')
        : String(existingDates[i][0]);
      rowIndexByDate[d] = i + 2;
    }
  }

  let updatedCount = 0;
  let insertedCount = 0;

  for (const d of dates) {
    const rec = dailyMap[d];
    const rowValues = [
      rec.date,
      rec.hrvLastNight,
      rec.hrvStatus,
      rec.bbMax,
      rec.bbLatest,
      rec.stressAvg,
      rec.steps,
      rec.sleepHours,
      updatedAt
    ];

    if (rowIndexByDate[d]) {
      sheet.getRange(rowIndexByDate[d], 1, 1, 9).setValues([rowValues]);
      updatedCount++;
    } else {
      sheet.appendRow(rowValues);
      insertedCount++;
    }
  }

  if (sheet.getLastRow() >= 3) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).sort({ column: 1, ascending: true });
  }

  console.log(`✅ バイタル同期完了（新規: ${insertedCount}件 / 更新: ${updatedCount}件）`);
}

/**
 * 【Geminiプロンプト注入用】過去30日平均との比較＋直近推移を整形して返す
 */
function getVitalSummaryForPrompt(recentDays) {
  const days = recentDays || 5;
  const sheet = getVitalSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return '【バイタルデータ（Garmin）】記録なし';
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
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

  if (!latest) {
    return '【バイタルデータ（Garmin）】有効なデータなし';
  }

  const lines = ['【バイタルデータ（Garmin 体調ログ）】'];

  // 過去30日基準値
  const baseParts = [];
  if (cntHrv > 0) baseParts.push(`HRV ${Math.round(sumHrv / cntHrv)}ms`);
  if (cntBbMax > 0) baseParts.push(`朝BodyBattery ${Math.round(sumBbMax / cntBbMax)}`);
  if (cntStress > 0) baseParts.push(`平均ストレス ${Math.round(sumStress / cntStress)}`);
  if (cntSteps > 0) baseParts.push(`歩数 ${Math.round(sumSteps / cntSteps)}歩`);
  if (baseParts.length > 0) {
    lines.push(`- 基準値（過去30日平均）: ${baseParts.join(' / ')}`);
  }

  // 最新日の状態と疲労アラート判定
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

  if (recentLines.length > 0) {
    lines.push(`- 直近${days}日間の推移:\n${recentLines.join('\n')}`);
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