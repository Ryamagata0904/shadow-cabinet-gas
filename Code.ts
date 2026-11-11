// @ts-ignore
const Chat = this["Chat"];

const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const SPACE_NAME = PropertiesService.getScriptProperties().getProperty('SPACE_NAME');
const LOG_DOC_ID = PropertiesService.getScriptProperties().getProperty('LOG_DOC_ID');
const CHAT_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL');

// USER_PROFILE はスクリプトプロパティにあればそれを優先し、無ければ Prompts.ts のデフォルトを使用
const USER_PROFILE = PropertiesService.getScriptProperties().getProperty('USER_PROFILE') || DEFAULT_USER_PROFILE;

const MODEL_NAME = 'gemini-3.8-flash';
const REVIEW_MODEL_NAME = 'gemini-3.8-flash';

const DYNAMIC_INTERVENTION_HANDLER = 'executeDynamicIntervention';
const DYNAMIC_INTERVENTION_LOG_DAYS = 3;
const DEFAULT_INTERVENTION_TIME = '19:30';
const INTERVENTION_CLOCK_PATTERN = /(?:[01]\d|2[0-3]):[0-5]\d/;

/**
 * log.xml から直近 N 件の対話履歴（短期記憶）を自動抽出する関数
 */
function getRecentLogs(fileId, count = 2) {
  try {
    if (!fileId) return "（過去ログなし）";
    const file = DriveApp.getFileById(fileId.trim());
    const content = file.getBlob().getDataAsString();
    
    const entries = content.split('</log_entry>');
    if (entries.length <= 1) return "（過去ログなし）";
    
    const recent = entries.slice(-count - 1, -1)
      .map(e => e.trim() + '</log_entry>')
      .join('\n');
      
    return recent;
  } catch (e) {
    console.error("短期記憶の取得エラー: " + e.toString());
    return "（過去ログ取得失敗）";
  }
}

/**
 * ユーザーの発言から、必要な過去ログの参照件数（0〜10件）をAIに判定させる
 */
function determineRequiredLogCount(userInput) {
  // 空文字などの場合はデフォルト2件
  if (!userInput || userInput.trim() === '') return 2;

  try {
    const prompt = `
ユーザーの以下の発言に対して、適切な助言・回答を行うために「過去の対話ログ」が何件必要か判定してください。

ユーザーの発言:
"${userInput}"

【判定基準】
- 0〜1件: 単発の挨拶、現在時刻の報告、過去の文脈が全く不要な新規の愚痴・相談
- 2〜3件: 「さっきの件」「続き」「どうすればいい？」など直前の流れが必要な場合
- 5〜10件: 「昨日から続いている」「これまでの経緯」「進捗の振り返り」など複数回にわたる経緯の参照が必要な場合

【出力ルール】
判定した「半角数字のみ」（例: 0, 2, 5）を出力してください。理由や前置きは一切含めないでください。`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent';
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // 判定のブレをなくすため低め
        maxOutputTokens: 10
      }
    };

    // @ts-ignore
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': GEMINI_API_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const count = parseInt(text, 10);

    // 0〜10の範囲内に安全に収める（パース失敗時は安全側に倒して 2件）
    if (!isNaN(count) && count >= 0 && count <= 10) {
      console.log(`🧠 AI判断によるログ遡り件数: ${count} 件 (発言: "${userInput.substring(0, 20)}...")`);
      return count;
    }
    return 2;
  } catch (e) {
    console.warn("ログ件数判定エラー（デフォルト2件を適用）: " + e.toString());
    return 2;
  }
}

function onMessage(event) {
  console.log(JSON.stringify(event));

  const spaceName = event?.space?.name 
                 || event?.message?.space?.name 
                 || event?.chat?.messagePayload?.message?.space?.name
                 || "取得不可";

  if (event?.space?.name) {
    PropertiesService.getScriptProperties().setProperty('SPACE_NAME', event.space.name);
  }

  const userMessage = event?.chat?.messagePayload?.message?.text || event?.message?.text;
  
  if (!userMessage) {
    console.log("メッセージテキストを取得できませんでした。");
    return;
  }

  // 過去ログの件数を判定
  const logCount = determineRequiredLogCount(userMessage);
  const recentLogs = logCount > 0 ? getRecentLogs(LOG_DOC_ID, logCount) : "";

  const nowJst = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss (E)");

  const enrichedUserMessage = `
【現在日時 (JST)】
${nowJst}
【ユーザーの長期記憶 (USER_PROFILE)】
${USER_PROFILE}

【直近の会話文脈 (短期記憶)】
${recentLogs}

---
【ユーザーからの新しいメッセージ】
${userMessage}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: enrichedUserMessage }] }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    // @ts-ignore
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());

    if (json.error) {
      console.error("Gemini API Error:", JSON.stringify(json.error));
      return {
        hostAppDataAction: {
          chatDataAction: {
            createMessageAction: {
              message: {
                text: `⚠️ APIエラー (${json.error.code}): ${json.error.message}`
              }
            }
          }
        }
      };
    }

    const replyText = json?.candidates?.[0]?.content?.parts?.[0]?.text || "回答を取得できませんでした。";
    saveLogToDoc(userMessage, replyText);

    return {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: {
              text: replyText
            }
          }
        }
      }
    };

  } catch (e) {
    return {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: {
              text: "⚠️ システムエラーが発生しました: " + e.toString()
            }
          }
        }
      }
    };
  }
}

function saveLogToDoc(userText, replyText) {
  try {
    if (!LOG_DOC_ID) {
      console.error("LOG_DOC_ID が未設定です。");
      return;
    }

    const fileId = LOG_DOC_ID.trim();
    const file = DriveApp.getFileById(fileId);
    const currentContent = file.getBlob().getDataAsString();
    
    const timestamp = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss");
    
    const newEntry = `
<log_entry>
  <timestamp>${timestamp}</timestamp>
  <user_input><![CDATA[${userText}]]></user_input>
  <ai_response><![CDATA[${replyText}]]></ai_response>
</log_entry>`;

    file.setContent(currentContent + newEntry);
    console.log("XMLログの保存に成功しました。");
  } catch (e) {
    console.error("ログ保存エラー: " + e.toString());
  }
}

function saveWeeklyArchive(logText) {
  const folderId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_FOLDER_ID');
  if (!folderId) {
    console.log("ARCHIVE_FOLDER_ID が未設定のため、アーカイブ作成をスキップしました。");
    return;
  }

  try {
    const folder = DriveApp.getFolderById(folderId.trim());
    const now = new Date();
    
    const yearMonth = Utilities.formatDate(now, "JST", "yyyyMM");
    const dayOfMonth = now.getDate();
    const weekNumber = Math.ceil(dayOfMonth / 7);
    
    const fileName = `${yearMonth}_W${weekNumber}.xml`;
    const existingFiles = folder.getFilesByName(fileName);

    if (existingFiles.hasNext()) {
      const file = existingFiles.next();
      const currentContent = file.getBlob().getDataAsString();
      file.setContent(currentContent + "\n" + logText);
      console.log(`既存のアーカイブファイル (${fileName}) に追記しました。`);
    } else {
      const initialXml = `<?xml version="1.0" encoding="UTF-8"?>\n<weekly_archive>\n${logText}\n</weekly_archive>`;
      folder.createFile(fileName, initialXml, MimeType.PLAIN_TEXT);
      console.log(`新規アーカイブファイル (${fileName}) を作成しました。`);
    }
    
  } catch (e) {
    console.error("アーカイブ保存エラー: " + e.toString());
  }
}

/**
 * 毎週1回実行: ログ分析 ➔ 改善コード生成 ➔ GitHub PR 作成 ➔ Chat通知
 */
function runWeeklyMetaReview() {
  if (!LOG_DOC_ID) return;
  
  try {
    const fileId = LOG_DOC_ID.trim();
    const file = DriveApp.getFileById(fileId);
    const logText = file.getBlob().getDataAsString();
    
    if (!logText || logText.trim() === '<?xml version="1.0" encoding="UTF-8"?>\n<logs>') {
      console.log("今週の新しいログはありませんでした。");
      return;
    }

    const metaPrompt = `
あなたはAIシステムの改善を行う「メタ・プロンプトエンジニア」兼「行動心理アナリスト」です。

以下は、過去1週間のユーザーとAI（Shadow Cabinet）のやり取りログです。
このデータを分析し、ユーザーが守れなかった約束、行動できなかった原因、AIの対応の反省点を踏まえ、
Prompts.ts を丸ごと置き換える最新のTypeScriptコードを生成してください。

【現在の SYSTEM_INSTRUCTION】
${SYSTEM_INSTRUCTION}

【現在の USER_PROFILE】
${USER_PROFILE}

【過去1週間のログデータ】
${logText}

【出力フォーマット指示（厳守）】
必ず以下の「===REPORT===」と「===CODE===」の区切り文字を使って出力してください。

===REPORT===
**【🔄 週間自己改善＆プロファイル更新レポート】**
■ 今週の主な分析・課題（3点以内）:
■ プロンプト＆プロファイルへの主な反映内容・変更点:

===CODE===
- 出力は \`Prompts.ts\` の完全なソースコードのみとしてください。
- 前置き、解説文、マークダウン記号（\`\`\`typescript や \`\`\`）は一切含めないでください。
- \`const SYSTEM_INSTRUCTION = \`...\`;\` と \`const DEFAULT_USER_PROFILE = \`...\`;\` の2つを必ず定義してください（※GASで動かすため、export キーワードは絶対に付けないでください）。
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${REVIEW_MODEL_NAME}:generateContent`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: metaPrompt }] }]
    };
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': GEMINI_API_KEY },
      payload: JSON.stringify(payload)
    };

    // @ts-ignore
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    if (json.error) throw new Error(json.error.message);
    

    const rawOutput = json.candidates[0].content.parts[0].text;

    // 1. レポート部分とコード部分を分離
    const parts = rawOutput.split('===CODE===');
    let reportText = '';
    let newPromptsCode = '';

    if (parts.length >= 2) {
      reportText = parts[0].replace('===REPORT===', '').trim();
      newPromptsCode = parts[1].trim();
    } else {
      newPromptsCode = rawOutput.trim();
      reportText = "🔄 **【週間自己改善レポート】**\n今週のログに基づきプロンプトを更新しました。";
    }

        
    // バッククォートの囲みがある場合はトリミング
    newPromptsCode = newPromptsCode.replace(/^```typescript\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim();

    // 1. GitHub に PR を自動作成
    const prUrl = createGithubPullRequest(newPromptsCode);

    // 2. Google Chat へ通知
    const notification = `${reportText}\n\n` +
      `**【📝 提案された最新プロンプト (Prompts.ts)】**\n` +
      `\`\`\`typescript\n${newPromptsCode}\n\`\`\`\n\n` +
      `🔗 **GitHub で差分確認＆マージ（1タップで本番反映）:**\n${prUrl}`;
    
    sendChatNotification(notification);

    // 3. アーカイブとログ初期化
    if (typeof saveWeeklyArchive === 'function') {
      saveWeeklyArchive(logText);
    }
    file.setContent('<?xml version="1.0" encoding="UTF-8"?>\n<logs>\n');
    console.log("週次レビューおよびPR作成が正常に完了しました。");

  } catch (e) {
    console.error("週次レビューエラー: " + e.toString());
    sendChatNotification("⚠️ 週次レビューでエラーが発生しました: " + e.toString());
  }
}

/**
 * GitHub API を使ってブランチ作成 ➔ Prompts.ts 更新 ➔ PR 起票を行う関数
 */
function createGithubPullRequest(newFileContent) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER');
  const repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO');

  if (!token || !owner || !repo) {
    throw new Error("GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO のいずれかがスクリプトプロパティに設定されていません。");
  }
  // 余計な空白や改行を取り除く
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  const cleanToken = token.trim();

  const baseUrl = 'https://api.github.com/repos/' + cleanOwner + '/' + cleanRepo;
  const headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GAS-Shadow-Cabinet'
  };

  const nowStr = Utilities.formatDate(new Date(), "JST", "yyyyMMdd-HHmmss");
  const branchName = 'improve/prompts-' + nowStr;

  // 1. main ブランチの最新 SHA を取得
  // @ts-ignore
  const refRes = UrlFetchApp.fetch(baseUrl + '/git/ref/heads/main', { headers: headers });
  const mainSha = JSON.parse(refRes.getContentText()).object.sha;

  // 2. 新しいブランチを作成
  // @ts-ignore
  UrlFetchApp.fetch(baseUrl + '/git/refs', {
    method: 'post',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      ref: 'refs/heads/' + branchName,
      sha: mainSha
    })
  });


// 3. 既存の Prompts.ts の SHA を取得
  // @ts-ignore
  const fileRes = UrlFetchApp.fetch(baseUrl + '/contents/Prompts.ts?ref=main', { headers: headers });
  const fileSha = JSON.parse(fileRes.getContentText()).sha;


  // 4. 新ブランチ上で Prompts.ts を更新コミット
  const base64Content = Utilities.base64Encode(newFileContent, Utilities.Charset.UTF_8);
  // @ts-ignore
  UrlFetchApp.fetch(baseUrl + '/contents/Prompts.ts', {
    method: 'put',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      message: 'refactor(prompts): weekly self-improvement update (' + nowStr + ')',
      content: base64Content,
      sha: fileSha,
      branch: branchName
    })
  });

  // 5. Pull Request を作成
  // @ts-ignore
  const prRes = UrlFetchApp.fetch(baseUrl + '/pulls', {
    method: 'post',
    headers: headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      title: `🔄 【自動改善】週次プロンプト＆プロファイル更新 (${nowStr})`,
      head: branchName,
      base: 'main',
      body: `過去1週間の対話ログに基づき、Gemini が自動生成した \`Prompts.ts\` の改善提案です。\n\n**【確認手順】**\n1. 上部の **[Files changed]** タブで変更内容を確認してください。\n2. 問題なければ **[Merge pull request]** ➔ **[Confirm merge]** をクリックしてください。\n3. GitHub Actions が自動で走り、GAS へ最新コードがデプロイされます。`
    })
  });

  const prJson = JSON.parse(prRes.getContentText());
  return prJson.html_url;
}

function sendChatNotification(messageText) {
  const spaceName = PropertiesService.getScriptProperties().getProperty('SPACE_NAME');
  if (!spaceName) {
    console.error("SPACE_NAME が未設定です。");
    return;
  }

  try {
    const chatApi = this["Chat"];
    chatApi.Spaces.Messages.create(
      { text: messageText },
      spaceName.trim()
    );
    console.log("【送信成功】ボットから直接メッセージを送信しました。");
  } catch (e) {
    console.error("【送信失敗】エラー: " + e.toString());
  }
}

/**
 * 毎朝の定期実行を想定。直近ログと内閣プロンプトから本日の介入時刻を1つ決め、
 * その時刻（JST）に executeDynamicIntervention を1回だけ走らせるトリガーを張る。
 * インストール用の毎朝トリガーは GAS の時間主導型トリガーで本関数を1本だけ登録する。
 */
function scheduleDynamicIntervention() {
  try {
    deleteDynamicInterventionTriggers(null);

    const now = new Date();
    const todayJst = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm (E)');
    const recentLogs = getLogsForLastDays(LOG_DOC_ID, DYNAMIC_INTERVENTION_LOG_DAYS);

    const prompt = `
あなたは Shadow Cabinet の行動介入スケジューラです。
今日のユーザーの状況・癖を考慮し、最も行動介入（アドバイス）が必要な時刻を1つだけ選べ。
選ぶ時刻は現在時刻より後であること。

【現在日時 (JST)】
${todayJst}

【ユーザーの長期記憶 (USER_PROFILE)】
${USER_PROFILE}

【内閣の行動原則 (SYSTEM_INSTRUCTION)】
${SYSTEM_INSTRUCTION}

【直近${DYNAMIC_INTERVENTION_LOG_DAYS}日の対話ログ】
${recentLogs && recentLogs.trim() !== '' ? recentLogs : '（直近ログなし）'}

【出力形式（絶対厳守）】
返答は半角5文字のみ。形式は HH:mm。例: 19:30
前置き、説明、理由、箇条書き、番号（1. や 1)）、引用符、改行、空白を一切含めるな。
1文字だけの数字、日本語、マークダウンは禁止。
正しい出力: 19:30
誤った出力: 1
誤った出力: 1. 19:30
`;

    const raw = requestGeminiText(prompt, 0, 1024);
    const schedule = resolveInterventionSchedule(raw, now);

    ScriptApp.newTrigger(DYNAMIC_INTERVENTION_HANDLER)
      .timeBased()
      .at(schedule.triggerAt)
      .create();

    console.log('動的介入トリガーを設定しました: ' + schedule.label + ' JST (' + schedule.triggerAt.toISOString() + ')' + (schedule.usedFallback ? ' [fallback]' : ''));
  } catch (err) {
    console.error('介入スケジュールエラー: ' + err.toString());
    sendChatNotification('⚠️ 本日の介入時刻の決定に失敗しました: ' + err.toString());
  }
}

/**
 * 指定日時トリガーから1回だけ実行される介入通知。
 * 送信後、自分を起動したトリガーを削除する。
 * @param {GoogleAppsScript.Events.TimeDriven} e
 */
function executeDynamicIntervention(e) {
  try {
    const nowJst = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss (E)');
    const recentLogs = getLogsForLastDays(LOG_DOC_ID, DYNAMIC_INTERVENTION_LOG_DAYS);

    const prompt = `
今この瞬間に必要な、短く強いワンアクション指示（コーチやナースからの介入）を1つだけ生成してください。

【現在日時 (JST)】
${nowJst}

【ユーザーの長期記憶 (USER_PROFILE)】
${USER_PROFILE}

【内閣の行動原則 (SYSTEM_INSTRUCTION)】
${SYSTEM_INSTRUCTION}

【直近${DYNAMIC_INTERVENTION_LOG_DAYS}日の対話ログ】
${recentLogs && recentLogs.trim() !== '' ? recentLogs : '（直近ログなし）'}

【出力ルール（厳守）】
- 話者は Coach または Nurse のどちらか1人。時刻と疲労の文脈で選ぶ。
- 今すぐできる動作を1つだけ。質問・選択肢・閣議録フォーマットは禁止。
- 2〜4行、プレーンテキスト。先頭行は「Coach:」または「Nurse:」。
- 末尾に「返信不要」と書く。
`;

    const advice = (requestGeminiText(prompt, 0.7, 256) || '').trim();
    const messageText = advice !== ''
      ? '**【⚡ 動的介入】**\n' + advice
      : '**【⚡ 動的介入】**\nCoach: 今の作業を1つ残して画面を閉じ、席を立て。返信不要';

    sendChatNotification(messageText);

    // メールでも届けたい場合は、スクリプトプロパティ USER_EMAIL を設定して以下を有効化する。
    // const userEmail = PropertiesService.getScriptProperties().getProperty('USER_EMAIL');
    // if (userEmail) {
    //   GmailApp.sendEmail(userEmail.trim(), 'Shadow Cabinet 動的介入', messageText);
    // }
  } catch (err) {
    console.error('動的介入エラー: ' + err.toString());
    sendChatNotification('⚠️ 動的介入の生成に失敗しました: ' + err.toString());
  } finally {
    deleteDynamicInterventionTriggers(e);
  }
}

/**
 * executeDynamicIntervention 用の指定日時トリガーを削除する。
 * イベントの triggerUid に一致するトリガーを消し、見つからなければ関数名で掃く。
 */
function deleteDynamicInterventionTriggers(e) {
  const uid = e && e.triggerUid ? String(e.triggerUid) : '';
  const triggers = ScriptApp.getProjectTriggers();

  if (uid !== '') {
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getUniqueId() === uid) {
        ScriptApp.deleteTrigger(triggers[i]);
        console.log('動的介入トリガーを削除しました: ' + uid);
        return;
      }
    }
  }

  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === DYNAMIC_INTERVENTION_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      console.log('動的介入トリガーを関数名で削除しました: ' + triggers[i].getUniqueId());
    }
  }
}

/**
 * Gemini にテキスト生成を依頼し、本文だけを返す。
 */
function requestGeminiText(prompt, temperature, maxOutputTokens) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY が未設定です。');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent';
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxOutputTokens
    }
  };

  // @ts-ignore
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': GEMINI_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());
  if (json.error) {
    throw new Error('Gemini API Error (' + json.error.code + '): ' + json.error.message);
  }
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * 返答本文から HH:mm を抜き出す。箇条書き番号や前置きが混ざっても時刻だけを拾う。
 * 全角数字・全角コロンは半角へ揃えてから判定する。
 * @returns {{hour: number, minute: number, label: string}|null}
 */
function parseInterventionClock(text) {
  if (text === null || text === undefined) return null;
  const normalized = String(text).replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  }).replace(/：/g, ':');
  const match = normalized.match(INTERVENTION_CLOCK_PATTERN);
  if (!match) return null;
  const label = match[0];
  return {
    hour: parseInt(label.slice(0, 2), 10),
    minute: parseInt(label.slice(3, 5), 10),
    label: label
  };
}

/**
 * 抽出失敗、またはその時刻がもう過ぎているときは 19:30 を使う。
 * フォールバック時刻も過ぎていれば翌日の同時刻にし、トリガー作成が過去日付で失敗しないようにする。
 */
function resolveInterventionSchedule(rawText, now) {
  const parsed = parseInterventionClock(rawText);
  const parsedAt = parsed ? jstTodayAt(parsed.hour, parsed.minute) : null;
  const parsedIsFuture = parsedAt && parsedAt.getTime() >= now.getTime() + 60 * 1000;

  let label = DEFAULT_INTERVENTION_TIME;
  let usedFallback = true;
  if (parsed && parsedIsFuture) {
    label = parsed.label;
    usedFallback = false;
  } else if (!parsed) {
    console.warn('介入時刻を解釈できませんでした: ' + rawText + ' 。フォールバック ' + DEFAULT_INTERVENTION_TIME + ' を使用します。');
  } else {
    console.warn('介入時刻が過去、または直近1分以内です: ' + parsed.label + ' 。フォールバック ' + DEFAULT_INTERVENTION_TIME + ' を使用します。');
  }

  const fallback = parseInterventionClock(label);
  let triggerAt = jstTodayAt(fallback.hour, fallback.minute);
  if (triggerAt.getTime() < now.getTime() + 60 * 1000) {
    triggerAt = new Date(triggerAt.getTime() + 24 * 60 * 60 * 1000);
    console.warn('フォールバック ' + label + ' も過ぎているため、翌日の同時刻にトリガーを設定します。');
  }

  return {
    hour: fallback.hour,
    minute: fallback.minute,
    label: label,
    usedFallback: usedFallback,
    triggerAt: triggerAt
  };
}

/**
 * 今日の JST の時分を、スクリプトのタイムゾーンに依存しない絶対時刻にする。
 */
function jstTodayAt(hour, minute) {
  const ymd = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const hh = ('0' + hour).slice(-2);
  const mm = ('0' + minute).slice(-2);
  return new Date(ymd + 'T' + hh + ':' + mm + ':00+09:00');
}

// 動作確認用テスト関数
function test_sendChatNotification() {
  const testMessage = "🧪 【送信テスト】Shadow Cabinet からの直接メッセージ送信確認です。";
  sendChatNotification(testMessage);
}

function _forceScopes() {
  DriveApp.getRootFolder();
  DocumentApp.create("dummy");
  ScriptApp.getProjectTriggers();
}

function testCheck() {
  console.log("✅ 認証完了！スクリプトは正常に動いています。");
  const folder = DriveApp.getRootFolder();
  console.log("マイドライブ取得成功: " + folder.getName());
}

// ==========================================
// 🧪 検証・単体テスト用メソッド群
// ==========================================

/**
 * 【検証1】ログ抽出機能のテスト
 * ・log.xml から直近7日分のログが正常に抽出できるか
 * ・元ファイルが消えずに保持されているか
 */

  /**
   * log.xml から「直近 days 日以内」のログエントリだけを抽出する関数
   */
  function getLogsForLastDays(fileId, days = 7) {
    try {
      if (!fileId) return "";
      const file = DriveApp.getFileById(fileId.trim());
      const content = file.getBlob().getDataAsString();
      
      const entries = content.split('</log_entry>');
      if (entries.length <= 1) return "";

      const now = new Date().getTime();
      const threshold = now - (days * 24 * 60 * 60 * 1000); // N日前のミリ秒
      
      const targetEntries = [];

      for (let i = 0; i < entries.length - 1; i++) {
        const entry = entries[i].trim() + '</log_entry>';
        // <timestamp>YYYY-MM-dd HH:mm:ss</timestamp> を抽出
        const match = entry.match(/<timestamp>(.*?)<\/timestamp>/);
        if (match && match[1]) {
          // GASで日付パース（JST）
          const entryTime = new Date(match[1].replace(/-/g, '/')).getTime();
          if (entryTime >= threshold) {
            targetEntries.push(entry);
          }
        } else {
          // タイムスタンプが取れない古いログは念のため含める
          targetEntries.push(entry);
        }
      }

      return targetEntries.join('\n');
    } catch (e) {
      console.error("期間ログ抽出エラー: " + e.toString());
      return "";
    }
  }

function test_checkLogsFiltering() {
  console.log("--- 【検証1】ログ抽出テスト開始 ---");
  const fileId = PropertiesService.getScriptProperties().getProperty('LOG_DOC_ID');
  if (!fileId) {
    console.error("❌ LOG_DOC_ID が未設定です。");
    return;
  }

  const file = DriveApp.getFileById(fileId.trim());
  const rawContent = file.getBlob().getDataAsString();
  const totalEntries = (rawContent.match(/<\/log_entry>/g) || []).length;
  console.log(`📊 元ファイル全体のログ件数: ${totalEntries} 件`);

  // 直近7日分のログを抽出
  const filteredLogs = getLogsForLastDays(fileId, 7);
  const filteredEntries = (filteredLogs.match(/<\/log_entry>/g) || []).length;
  console.log(`📅 直近7日以内の対象ログ件数: ${filteredEntries} 件`);

  if (filteredEntries > 0) {
    console.log("✅ ログの抽出に成功しました。先頭1件のプレビュー:");
    const firstEntry = filteredLogs.split('</log_entry>')[0] + '</log_entry>';
    console.log(firstEntry);
  } else {
    console.warn("⚠️ 直近7日以内のログが見つかりませんでした（古い日付のみ、またはログが空です）。");
  }

  // 元ファイルが変化していないか再確認
  const afterCheckContent = file.getBlob().getDataAsString();
  if (rawContent.length === afterCheckContent.length) {
    console.log("✅ 元ファイル（log.xml）のデータ保持を確認（消去されていません）。");
  } else {
    console.error("❌ 警告: 元ファイルのデータ長が変化しています。");
  }
}

/**
 * 【検証2】GitHub API 疎通確認テスト
 * ・GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO の有効性
 * ・main ブランチの参照権限があるか
 */
function test_checkGithubApi() {
  console.log("--- 【検証2】GitHub API 疎通テスト開始 ---");
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER');
  const repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO');

  console.log(`設定値確認 -> OWNER: ${owner}, REPO: ${repo}, TOKEN: ${token ? '設定済み(' + token.substring(0, 7) + '...)' : '未設定'}`);

  if (!token || !owner || !repo) {
    console.error("❌ GitHub 関連のスクリプトプロパティが不足しています。");
    return;
  }

  const headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GAS-Shadow-Cabinet'
  };

  try {
    // 1. リポジトリへのアクセス確認
    const repoRes = UrlFetchApp.fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: headers,
      muteHttpExceptions: true
    });

    if (repoRes.getResponseCode() !== 200) {
      console.error(`❌ リポジトリ取得失敗 (HTTP ${repoRes.getResponseCode()}): ${repoRes.getContentText()}`);
      return;
    }
    console.log("✅ リポジトリへのアクセス権限 OK");

    // 2. main ブランチの SHA 取得確認
    const refRes = UrlFetchApp.fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`, {
      headers: headers,
      muteHttpExceptions: true
    });

    if (refRes.getResponseCode() !== 200) {
      console.error(`❌ main ブランチの参照失敗 (HTTP ${refRes.getResponseCode()}): ${refRes.getContentText()}`);
      return;
    }

    const sha = JSON.parse(refRes.getContentText()).object.sha;
    console.log(`✅ main ブランチの SHA 取得成功 (${sha})`);

    // 3. Prompts.ts が存在するか確認
    const fileRes = UrlFetchApp.fetch(`https://api.github.com/repos/${owner}/${repo}/contents/Prompts.ts?ref=main`, {
      headers: headers,
      muteHttpExceptions: true
    });

    if (fileRes.getResponseCode() === 200) {
      console.log("✅ Prompts.ts の存在を確認しました。PR作成の前提条件はすべてクリアです。");
    } else {
      console.warn(`⚠️ GitHub の main ブランチに Prompts.ts が見つかりません (HTTP ${fileRes.getResponseCode()})。先に手動で push してください。`);
    }

  } catch (e) {
    console.error("❌ 通信エラー: " + e.toString());
  }
}

/**
 * 【検証3】週次改善のドライラン（疑似実行）
 * ・Gemini にプロンプト改善案を作らせる
 * ・PR 起票や Chat 通知は行わず、生成結果だけをログに出力して品質を確認する
 */
function test_dryRunWeeklyMetaReview() {
  console.log("--- 【検証3】週次改善ドライラン開始 ---");
  const fileId = PropertiesService.getScriptProperties().getProperty('LOG_DOC_ID');
  const geminiApiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  if (!fileId || !geminiApiKey) {
    console.error("❌ 必要なプロパティが不足しています。");
    return;
  }

  const logText = getLogsForLastDays(fileId, 7);
  if (!logText || logText.trim() === '') {
    console.warn("⚠️ 直近7日分のログが存在しないため、ダミーログを使用してドライランを行います。");
  }

  const testLogs = logText || `
<log_entry>
  <timestamp>2026-11-02 21:30:00</timestamp>
  <user_input>残業で遅くなった。疲れたのでコンビニ寄って帰る</user_input>
  <ai_response>Coach: 歩きバナナを摂取し、帰宅後は即ベッド直行せよ。</ai_response>
</log_entry>`;

  const metaPrompt = `
あなたはAIシステムの改善を行う「メタ・プロンプトエンジニア」兼「行動心理アナリスト」です。
以下のログから Prompts.ts の改善版 TypeScript コードのみを出力してください。
コード以外の解説文やマークダウン記号（\`\`\`typescript や \`\`\`）は含めないでください。

【現在の SYSTEM_INSTRUCTION】
${SYSTEM_INSTRUCTION}

【現在の USER_PROFILE】
${USER_PROFILE}

【対話ログ】
${testLogs}
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${REVIEW_MODEL_NAME}:generateContent`;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': geminiApiKey },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: metaPrompt }] }] }),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.error) {
      console.error("❌ Gemini API エラー: " + JSON.stringify(json.error));
      return;
    }

    let generatedCode = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    generatedCode = generatedCode.replace(/^```typescript\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim();

    console.log("✅ Gemini による改善コード生成成功！");
    console.log("--- 生成コードの先頭200文字 ---");
    console.log(generatedCode.substring(0, 200) + "...\n-----------------------------");

    // 必須要素が含まれているかの構文バリデーション
    const hasInstruction = generatedCode.includes("SYSTEM_INSTRUCTION");
    const hasProfile = generatedCode.includes("DEFAULT_USER_PROFILE");

    if (hasInstruction && hasProfile) {
      console.log("✅ 検証合格: SYSTEM_INSTRUCTION および DEFAULT_USER_PROFILE が正常に出力に含まれています。");
    } else {
      console.error(`❌ 構文警告: 必須変数が欠落しています (Instruction: ${hasInstruction}, Profile: ${hasProfile})`);
    }

  } catch (e) {
    console.error("❌ ドライラン失敗: " + e.toString());
  }
}