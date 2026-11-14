const GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';
const BP_FILE_NAME = 'ShadowCabinet_VitalLogs'; // 作成されるスプレッドシートの名前

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
function getBloodPressureSheet_() {
  // 1. メインファイルで定義されている LOG_DOC_ID から親フォルダを特定
  const logFile = DriveApp.getFileById(LOG_DOC_ID);
  const parents = logFile.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  // 2. 同じフォルダ内にすでに血圧ログシートがあるか検索
  const files = folder.searchFiles(`title = "${BP_FILE_NAME}" and mimeType = "${MimeType.GOOGLE_SHEETS}"`);
  
  let ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    // 3. なければ新規作成し、チャットログと同じフォルダへ移動する
    ss = SpreadsheetApp.create(BP_FILE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    
    // シートの初期設定（ヘッダー作成）
    const sheet = ss.getActiveSheet();
    sheet.setName('BloodPressure');
    sheet.appendRow(['measurement_id', 'measured_at', 'date', 'systolic', 'diastolic', 'pulse']);
    sheet.setFrozenRows(1);
  }
  
  return ss.getSheetByName('BloodPressure') || ss.getSheets()[0];
}

/**
 * 【日次バッチ用】Garmin から直近の血圧を取得し、スプレッドシートへ追記する
 */
function syncGarminBloodPressureToSheet() {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 直近2〜3日分を取得

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');

  const url = `${GARMIN_BASE_URL}/bloodpressure-service/bloodpressure/range/${startDate}/${endDate}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Garmin 血圧取得失敗: ${res.getContentText()}`);
  }

  const data = JSON.parse(res.getContentText());
  const summaries = data.measurementSummaries || [];
  if (summaries.length === 0) return;

  const sheet = getBloodPressureSheet_();
  const lastRow = sheet.getLastRow();
  const existingIds = new Set();
  if (lastRow >= 2) {
    const idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    idValues.forEach(row => existingIds.add(String(row[0])));
  }

  const newRows = [];
  for (const daySummary of summaries) {
    const dateLabel = daySummary.calendarDate ||
      (daySummary.startTimestampGMT ? daySummary.startTimestampGMT.slice(0, 10) : '日付不明');
    const items = Array.isArray(daySummary.measurements) && daySummary.measurements.length > 0
      ? daySummary.measurements : [daySummary];

    for (const m of items) {
      const sys = m.systolic !== undefined ? m.systolic : m.highValue;
      const dia = m.diastolic !== undefined ? m.diastolic : m.lowValue;
      const pulse = m.pulse !== undefined ? m.pulse : (m.heartRate || '');

      if (!sys || !dia) continue;

      const rawTime = m.measurementTimeLocal || m.measurementTimeGMT || m.startTimestampGMT || dateLabel;
      const measurementId = `${rawTime}_${sys}_${dia}`;

      if (!existingIds.has(measurementId)) {
        const measuredAt = String(rawTime).replace('T', ' ').slice(0, 16);
        newRows.push([measurementId, measuredAt, dateLabel, sys, dia, pulse]);
        existingIds.add(measurementId);
      }
    }
  }

  if (newRows.length > 0) {
    sheet.getRange(lastRow + 1, 1, newRows.length, 6).setValues(newRows);
    if (sheet.getLastRow() >= 3) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).sort({ column: 2, ascending: true });
    }
    console.log(`✅ 血圧データを ${newRows.length} 件追記しました。`);
  } else {
    console.log('新規の血圧データはありませんでした。');
  }
}

/**
 * 【Geminiプロンプト注入用】過去30日平均との差分＋直近推移を整形して返す
 */
function getVitalSummaryForPrompt(recentDays = 7) {
  const sheet = getBloodPressureSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '【バイタルデータ（Garmin 血圧ログ）】記録なし';

  const rows = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);

  let sumSys = 0, sumDia = 0, sumPulse = 0;
  let count30 = 0, countPulse = 0;
  const recentLines = [];
  let latestRecord = null;

  for (const row of rows) {
    const measuredAt = String(row[1]);
    const recordDate = new Date(String(row[2]));
    const sys = Number(row[3]);
    const dia = Number(row[4]);
    const pulse = row[5] !== '' ? Number(row[5]) : '';

    if (!sys || !dia || isNaN(recordDate.getTime())) continue;

    if (recordDate >= thirtyDaysAgo) {
      sumSys += sys; sumDia += dia; count30++;
      if (typeof pulse === 'number') { sumPulse += pulse; countPulse++; }
    }

    if (recordDate >= recentCutoff) {
      recentLines.push(`  - ${measuredAt}: ${sys}/${dia} mmHg` + (pulse ? ` (脈拍 ${pulse})` : ''));
    }
    latestRecord = { measuredAt, sys, dia, pulse };
  }

  if (!latestRecord) return '【バイタルデータ（Garmin 血圧ログ）】有効なデータなし';

  const lines = ['【バイタルデータ（Garmin 血圧ログ）】'];
  if (count30 > 0) {
    const avgSys = Math.round(sumSys / count30);
    const avgDia = Math.round(sumDia / count30);
    const avgPulseStr = countPulse > 0 ? `（脈拍 ${Math.round(sumPulse / countPulse)}）` : '';
    lines.push(`- 基準値（過去30日平均）: ${avgSys} / ${avgDia} mmHg${avgPulseStr}`);

    const diffSys = latestRecord.sys - avgSys;
    const diffDia = latestRecord.dia - avgDia;
    const diffSysStr = diffSys >= 0 ? `+${diffSys}` : `${diffSys}`;
    const diffDiaStr = diffDia >= 0 ? `+${diffDia}` : `${diffDia}`;
    const statusNote = (diffSys >= 10 || latestRecord.sys >= 135 || latestRecord.dia >= 85)
      ? ' ※基準より高め（疲労・ストレス注意）' : ' ※平常範囲内';

    lines.push(`- 最新値（${latestRecord.measuredAt}）: ${latestRecord.sys} / ${latestRecord.dia} mmHg [基準比: ${diffSysStr} / ${diffDiaStr}]${statusNote}`);
  }

  if (recentLines.length > 0) {
    lines.push(`- 直近${recentDays}日間の推移:\n${recentLines.join('\n')}`);
  }

  return lines.join('\n');
}

function testGarminEndpoints() {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(now.getTime() / 1000);

  // Garmin Connect / Personal API で使われる代表的な血圧エンドポイント候補
  const candidates = [
    `/bloodpressure-service/bloodpressure/${startDate}/${endDate}`,
    `/bloodpressure-service/bloodpressure/daily/${endDate}`,
    `/wellness-api/rest/bloodPressures?uploadStartTimeInSeconds=${startSec}&uploadEndTimeInSeconds=${endSec}`,
    `/personal-api/wellness/bloodPressures?uploadStartTimeInSeconds=${startSec}&uploadEndTimeInSeconds=${endSec}`,
    `/personal-api/bloodpressure/range/${startDate}/${endDate}`
  ];

  for (const path of candidates) {
    const res = UrlFetchApp.fetch(`${GARMIN_BASE_URL}${path}`, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    console.log(`[${code}] ${path}`);
    if (code === 200) {
      console.log('★取得成功レスポンス:', res.getContentText().slice(0, 500));
    }
  }
}