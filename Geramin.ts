const GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';

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
      headers: {
        Authorization: `ApiKey ${apiKey}`
      },
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

  // トークン有効期限は24時間のため、23時間（82800秒）キャッシュする
  cache.put('GARMIN_ACCESS_TOKEN', token, 82800);
  return token;
}

/**
 * 指定日数分の Garmin 血圧データを取得し、プロンプト注入用のサマリー文字列を返す
 */
function getGarminBloodPressureSummary(days = 7) {
  const token = getGarminAccessToken_();
  const now = new Date();
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const startDate = Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd');
  const endDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');

  const url = `${GARMIN_BASE_URL}/bloodpressure-service/bloodpressure/range/${startDate}/${endDate}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Garmin 血圧取得失敗 (${res.getResponseCode()}): ${res.getContentText()}`);
  }

  const data = JSON.parse(res.getContentText());
  const summaries = data.measurementSummaries || [];
  if (summaries.length === 0) {
    return `【直近${days}日間の血圧データ】記録なし`;
  }

  const lines = [];
  for (const daySummary of summaries) {
    const dateLabel = daySummary.calendarDate ||
      (daySummary.startTimestampGMT ? daySummary.startTimestampGMT.slice(0, 10) : '日付不明');
    // 1日に複数回測っている場合は個別測定値、なければ日次サマリーを使用
    const items = Array.isArray(daySummary.measurements) && daySummary.measurements.length > 0
      ? daySummary.measurements
      : [daySummary];

    for (const m of items) {
      const sys = m.systolic !== undefined ? m.systolic : m.highValue;
      const dia = m.diastolic !== undefined ? m.diastolic : m.lowValue;
      const pulse = m.pulse !== undefined ? m.pulse : m.heartRate;
      if (sys && dia) {
        lines.push(`- ${dateLabel}: 最高 ${sys} / 最低 ${dia} mmHg` + (pulse ? ` (脈拍 ${pulse})` : ''));
      }
    }
  }

  return lines.length > 0
    ? `【直近${days}日間の血圧データ（Garmin）】\n${lines.join('\n')}`
    : `【直近${days}日間の血圧データ】有効な数値なし`;
}