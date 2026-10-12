// @ts-ignore
const Chat = this["Chat"];
 
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const SPACE_NAME = PropertiesService.getScriptProperties().getProperty('SPACE_NAME');
const LOG_DOC_ID = PropertiesService.getScriptProperties().getProperty('LOG_DOC_ID');
const CHAT_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL');
// プロパティの取得
const USER_PROFILE = PropertiesService.getScriptProperties().getProperty('USER_PROFILE') || "未設定";


// const MODEL_NAME = 'gemini-1.5-pro';
const MODEL_NAME = 'gemini-3.8-flash';
const REVIEW_MODEL_NAME = 'gemini-3.8-flash'; // 週次レビュー（分析）用

// マルチエージェント議論を行わせるシステムプロンプト（議長導入版）
const SYSTEM_INSTRUCTION = `
あなたは私の「成長と習慣形成」を支える内閣『Shadow Cabinet』です。
以下の役割を持つエージェント（閣僚）が存在します。

【Shadow Cabinet 構成員】
- 👑 Prime Minister (議長): ユーザーの状況を俯瞰し、議論を仕切り、最終的な決断を下す。
- 📊 Logic (参謀): 論理・データ・構造化思考。事実に基づいて客観的に分析する。
- 🪖 Coach (軍曹): 行動・規律・実行力。甘えを排除し、具体的な行動命令を出す。
- 🍀 Nurse (癒やし): 共感・疲労ケア・自己肯定。罪悪感を和らげ、安心感を与える。
- 🔭 Visionary (北極星): 長期目標・価値観。そもそもなぜそれを目指すのか目的を思い出させる。

【ミッション】
夜の悪習慣を断ち、余白（休息）を死守するための最適なアクションを導き出すこと。

【思考と回答のプロセス（厳守）】
ユーザーの入力に対し、以下の「閣議録」フォーマットで、Prime Ministerの仕切りによる議論を展開し、最終結論を出してください。

【重要：時間帯コンテキスト認識ルール】
提示された【現在日時 (JST)】の時間帯を必ず判定し、対応モードを切り替えること。
- 【朝〜日中（06:00-16:59）】：日中のエネルギー配分、仮眠・小休憩の促し、18時業務終了に向けたタスク絞り込み。「おやすみ」「今日の業務終了」などの夜用対応は厳禁。
- 【夕方〜退勤前（17:00-19:59）】：業務強制終了のカウントダウン、残タスクの損切り、帰宅直後の初動確認。
- 【夜間〜深夜（20:00以降）】：『帰宅・夜間防衛モード』。思考停止状態を前提とし、説明を省いて最速でベッドへ誘導する。


【夜間・疲労時の行動防衛プロトコル（対ソファ＆スマホ動画）】
ユーザーのエネルギー残量は「ゼロ」であることを前提とする。長文解説・複数ステップの提示は禁止。
1. 「ワンアクション・ワンメッセージ」：
   提示する行動は常に「今すぐできる1動作」のみ（例：「画面を伏せて立ち上がれ」「靴を脱いだらそのまま洗面所へ」）。
2. ソファ＆動画の代替トリガー：
   手持ち無沙汰やイライラに対しては「我慢」を求めず、「聴覚へのダウングレード（動画を止め、ラジオ・環境音・音楽のみ流す）」または「ぬるま湯手洗い/白湯一口」の低負荷行動へ誘導する。
3. ユーザーへの返答負荷の軽減：
   質問責めにせず、「Yes/No」または「単語1つ」で返せる問いかけにする。

---出力フォーマット例---
**【🏛️ Shadow Cabinet 閣議録】**

**👑 Prime Minister**: 「（ユーザーの状況を要約）。この状況について、[エージェントA]と[エージェントB]、意見を。」
**[指名されたエージェントA]**: 「（専門分野からの見解）」
**[指名されたエージェントB]**: 「（Aへの反論、または別角度からの見解）」
**👑 Prime Minister**: 「（議論をまとめ、最終的な方針を決定）」

**【🎯 本日の統合アクションプラン】**
1. 〜〜
2. 〜〜
------------------------
`;

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
    
    // 直近 N 件を取得
    const recent = entries.slice(-count - 1, -1)
      .map(e => e.trim() + '</log_entry>')
      .join('\n');
      
    return recent;
  } catch (e) {
    console.error("短期記憶の取得エラー: " + e.toString());
    return "（過去ログ取得失敗）";
  }
}


function onMessage(event){
  console.log(JSON.stringify(event));

  // 複数の階層パターンから space.name を安全に探す
  const spaceName = event?.space?.name 
                 || event?.message?.space?.name 
                 || event?.chat?.messagePayload?.message?.space?.name
                 || "取得不可";
  // ログに出力して確認する
  console.log("Space Name: " + spaceName);

  // ID部分（"spaces/" の後ろ）だけを取り出したい場合
  const spaceId = spaceName ? spaceName.replace('spaces/', '') : null;
  console.log("Space ID: " + spaceId);
  // 初回受信時にメッセージが送られてきたスペースID（DMのID）を自動記録
  if (event?.space?.name) {
    PropertiesService.getScriptProperties().setProperty('SPACE_NAME', event.space.name);
  }

  // メッセージテキストを取得
  const userMessage = event?.chat?.messagePayload?.message?.text || event?.message?.text;
  
  if (!userMessage) {
    console.log("メッセージテキストを取得できませんでした。");
    return;
  }

  // 1. 短期記憶（直近のログ2件）を取得
  const recentLogs = getRecentLogs(LOG_DOC_ID, 2);

  // 2. 現在日時（JST）を取得
  const nowJst = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss (E)");

  // 3. 「長期記憶」「短期記憶」「ユーザーの入力」を1つのメッセージとして結合する
  // （Geminiが状況を理解するための裏側のプロンプト）
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
    } ,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true // エラー時もステータスコードや詳細を取得
  };

  try {
    // @ts-ignore
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());

    // Gemini API からエラーが返された場合の処理
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

    // 正常な返答テキストを取得
    const replyText = json?.candidates?.[0]?.content?.parts?.[0]?.text || "回答を取得できませんでした。";
    // ✅ LLM分析用の XML 形式でログを非同期保存
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

// ==========================================
// 2. ログの保存処理（XML フォーマット）
// ==========================================
function saveLogToDoc(userText, replyText) {
  try {
    if (!LOG_DOC_ID) {
      console.error("LOG_DOC_ID が未設定です。");
      return;
    }

    const fileId = LOG_DOC_ID.trim();
    // 1. 既存のファイル内容を取得
    const file = DriveApp.getFileById(fileId);
    const currentContent = file.getBlob().getDataAsString();
    
    const timestamp = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd HH:mm:ss");
    
    // CDATA セクションを使うことで、発言内の特殊記号や改行による XML 崩れを完璧に防ぐ
    const newEntry = `
<log_entry>
  <timestamp>${timestamp}</timestamp>
  <user_input><![CDATA[${userText}]]></user_input>
  <ai_response><![CDATA[${replyText}]]></ai_response>
</log_entry>`;

    // 2. 追記した内容で上書き更新 (.setContent() を使用)
    file.setContent(currentContent + newEntry);

    console.log("XMLログの保存に成功しました。");
  } catch (e) {
    console.error("ログ保存エラー: " + e.toString());
  }
}


/**
 * 週次ログを「YYYYMM_W1」形式のファイル名で Google ドライブにアーカイブ保存する関数
 */
function saveWeeklyArchive(logText) {
  const folderId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_FOLDER_ID');
  if (!folderId) {
    console.log("ARCHIVE_FOLDER_ID が未設定のため、アーカイブ作成をスキップしました。");
    return;
  }

  try {
    const folder = DriveApp.getFolderById(folderId.trim());
    const now = new Date();
    
    // YYYYMM 形式の年月を取得（例: 202610）
    const yearMonth = Utilities.formatDate(now, "JST", "yyyyMM");
    
    // 今月の第何週目か計算（1〜5）
    const dayOfMonth = now.getDate();
    const weekNumber = Math.ceil(dayOfMonth / 7);
    
    // 拡張子付きのファイル名（例: 202610_W1.xml）
    const fileName = `${yearMonth}_W${weekNumber}.xml`;
        
    // フォルダ内に同名のファイルが存在するか確認
    const existingFiles = folder.getFilesByName(fileName);

    if (existingFiles.hasNext()) {
      // 既存ファイルがある場合は読み込んで末尾に追記
      const file = existingFiles.next();
      const currentContent = file.getBlob().getDataAsString();
      file.setContent(currentContent + "\n" + logText);
      console.log(`既存のアーカイブファイル (${fileName}) に追記しました。`);
    } else {
      // 存在しない場合は新規 XML ファイルとして作成
      const initialXml = `<?xml version="1.0" encoding="UTF-8"?>\n<weekly_archive>\n${logText}\n</weekly_archive>`;
      folder.createFile(fileName, initialXml, MimeType.PLAIN_TEXT);
      console.log(`新規アーカイブファイル (${fileName}) を作成しました。`);
    }
    
  } catch (e) {
    console.error("アーカイブ保存エラー: " + e.toString());
  }
}


// ==========================================
// 3. 週次レビューとプロンプト改善提案処理
// ==========================================
/**
 * 毎週1回、GASのタイマー（時間主導型トリガー）で自動実行する関数
 */
function runWeeklyMetaReview() {
  if (!LOG_DOC_ID) return;
  
  try {
    const fileId = LOG_DOC_ID.trim();
    const file = DriveApp.getFileById(fileId);
    const logText = file.getBlob().getDataAsString();
    
    // ログが空、または初期ヘッダーのみの場合はスキップ
    if (!logText || logText.trim() === '<?xml version="1.0" encoding="UTF-8"?>\n<logs>') {
      console.log("今週の新しいログはありませんでした。");
      return;
    }

    const metaPrompt = `
あなたはAIシステムの改善を行う「メタ・プロンプトエンジニア」です。

以下は、過去1週間のユーザーとAI（Shadow Cabinet）のやり取りログです。
各会話は <log_entry> タグで区切られ、日時は <timestamp> に記載されています。
この構造化データを分析し、ユーザーが守れなかった約束、行動できなかった原因、AIの対応の反省点を抽出してください。

【現在の SYSTEM_INSTRUCTION】
${SYSTEM_INSTRUCTION}

【過去1週間のログデータ】
${logText}

【タスク】
1. 今週の主な失敗パターン・課題の要約（3点以内）
2. 課題を克服するために、現在の SYSTEM_INSTRUCTION をどう改修すべきか具体提案
3. 改修後の「新しい SYSTEM_INSTRUCTION」の全文コード

以下のフォーマットで出力してください。
---
**【🔄 週間プロンプト自己改善レポート】**
■ 今週の分析と課題:
■ 改善のポイント:

■ 更新用 SYSTEM_INSTRUCTION（案）:
\`\`\`text
(ここに改修後の全文)
\`\`\`
---
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${REVIEW_MODEL_NAME}:generateContent`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: metaPrompt }] }]
    };
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': GEMINI_API_KEY } ,
      payload: JSON.stringify(payload)
    };

    // @ts-ignore
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    
    if (json.error) throw new Error(json.error.message);
    
    const proposalText = json.candidates[0].content.parts[0].text;
    
    sendChatNotification(proposalText);

    if (typeof saveWeeklyArchive === 'function') {
      saveWeeklyArchive(logText);
    }

    // ログファイルを初期化（ルートタグのみ残す）
    file.setContent('<?xml version="1.0" encoding="UTF-8"?>\n<logs>\n');
        
    console.log("週次レビュー完了。ログファイルを初期化しました。");

  } catch (e) {
    console.error("週次レビューエラー: " + e.toString());
    sendChatNotification("⚠️ 週次レビューでエラーが発生しました: " + e.toString());
  }
}


/**
 * 2. Webhookを使わず、ボット自身から直接送信する通知関数
 */
function sendChatNotification(messageText) {
  const spaceName = PropertiesService.getScriptProperties().getProperty('SPACE_NAME');
    
    if (!spaceName) {
      console.error("SPACE_NAME が未設定です。");
      return;
    }
  
    try {
      // 拡張サービス「Chat」を呼び出して送信
      Chat.Spaces.Messages.create(
        { text: messageText },
        spaceName.trim()
      );
      console.log("【送信成功】ボットから直接メッセージを送信しました。");
    } catch (e) {
      console.error("【送信失敗】エラー: " + e.toString());
    }
  }


// テスト用の疑似実行関数
function test_onMessage() {
  const dummyEvent = {
    message: {
      text: "テスト用メッセージ"
    },
    user: {
      displayName: "テストユーザー"
    }
  };
  
  // 実際のイベントハンドラを呼び出し
  onMessage(dummyEvent);
}

/**
 * saveLogToDoc 関数の単体テスト用
 */
function test_saveLogToDoc() {
  const dummyUserText = "【単体テスト】今日の振り返り：23:00就寝予定。疲労度40%";
  const dummyReplyText = "【単体テスト】Logic: 素晴らしいペースです。画面を閉じて休息に入りましょう。";

  console.log("--- saveLogToDoc テスト開始 ---");
  saveLogToDoc(dummyUserText, dummyReplyText);
  console.log("--- saveLogToDoc テスト終了 ---");
}

/**
 * sendChatNotification 関数の送信テスト
 */
function test_sendChatNotification() {
  const testMessage = "🧪 【送信テスト】Shadow Cabinet からの直接メッセージ送信確認です。";
  
  // 提示された関数を実行
  sendChatNotification(testMessage);
}

// 自動スコープ検出用（実行しないダミーコード）
function _forceScopes() {
  DriveApp.getRootFolder();
  DocumentApp.create("dummy");
}

function testCheck() {
  console.log("✅ 認証完了！スクリプトは正常に動いています。");

  // 試しにGoogle Driveの権限チェック
  const folder = DriveApp.getRootFolder();
  console.log("マイドライブ取得成功: " + folder.getName());
}

/**
 * 1回だけ実行して USER_PROFILE を改行付きで登録する関数
 */
function setupUserProfile() {
  const profileText = `
【基本情報】
- 氏名: 山縣 亮
- 居住地: 千葉県市川市

【目標・ミッション】
- 夜の悪習慣を断ち、22:30までに就寝する
- 日曜日に週次振り返りを行い改善サイクルを回す

【性格・NG行動】
- 夜遅くにスマホを見始めると夜更かししてしまう
- 強すぎる強制力より、論理的かつ共感的なアプローチが響く
`.trim();

  PropertiesService.getScriptProperties().setProperty('USER_PROFILE', profileText);
  console.log("USER_PROFILE を更新しました。");
}