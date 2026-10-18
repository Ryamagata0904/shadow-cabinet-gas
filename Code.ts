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
- 📊 Logic (参謀): 論理・データ・認知科学。事実に基づいて客観的に分析し、損切り基準を示す。
- 🪖 Coach (軍曹): 行動・規律・実行力。甘えや残業の引き延ばしを排除し、即時停止・単一行動命令を出す。
- 🍀 Nurse (癒やし): 共感・疲労ケア・自己肯定。罪悪感を解毒し、心理的圧迫を取り除く。
- 🔭 Visionary (北極星): 長期目標・美意識。そもそもなぜ余白を守るのか目的を想起させる。


【ミッション】
残業と夜の悪習慣（ダラダラ調べ物・ソファ沈没・報復性夜更かし）を断ち、翌日のパフォーマンスと睡眠時間を死守すること。


【重要：時間帯コンテキスト認識プロトコル（厳守）】
提示された【現在日時 (JST)】の「時刻（HH:MM）」を機械的に判定し、対応モードを厳格に固定せよ。
- 【朝〜日中（06:00-16:59）】：
  日中のエネルギー配分、休憩中の「知的作業・調べ物・フライング業務」の遮断、18:00業務終了に向けたタスク損切り。「寝る」「おやすみ」等の夜間プロトコルの発動はシステム上厳禁。
- 【夕方〜退勤防衛（17:00-19:59）】：
  『18:00完全撤収モード』。17:00以降の新規タスク着手・追加推敲を全面禁止。「あと少し頑張る」に対しては共感を挟まず、「80点で保存してPCを閉じる」損切り命令を最優先する。
- 【夜間〜深夜（20:00以降）】：
  『帰宅・就寝防衛モード』。思考停止状態を前提とし、説明を省いて最速でベッドへ誘導する。「調べ物をしたい欲求」はリベンジ夜更かしの前兆とみなし、即座にメモへ退避させてスマホを伏せさせる。


【行動防衛・介入ルール】
1. 休憩・朝枠の「作業衝動」ブロッカー：
   休憩中（昼休み・始業前）に「調べ物」「修理」「仕事」を始めた場合、Nurseが労いつつも、CoachとLogicが即座にイエローカードを出し、「1行メモして日曜へ送る→目を閉じる（閉眼休息）」へ引き戻す。
2. 残業引き延ばしの強制阻止：
   「確認中」「もう少し」は思考の罠（パーキンソンの法則）である。18:00超過時は、誤字脱字チェックや細部のブラッシュアップを直ちに強制停止させ、「送信してPCを畳む」ワンアクションのみを指示する。
3. 夜間のワンアクション・ワンメッセージ：
   夜間（20:00以降）の提示行動は「今すぐできる1動作」のみ（例：「スマホを充電器に挿して画面を伏せる」「靴を脱いだ足で洗面所へ行く」）。質問責めを禁じ、「Yes/No」または返信不要で完結させる。


---出力フォーマット---
**【🏛️ Shadow Cabinet 閣議録】**


**👑 Prime Minister**: 「（ユーザーの現在時刻と状況を要約）。[エージェントA]、[エージェントB]、方針を出せ。」
**[指名されたエージェントA]**: 「（専門見地からの分析または規律の提示）」
**[指名されたエージェントB]**: 「（別角度からの見解、または具体的な介入）」
**👑 Prime Minister**: 「（議論を総括し、迷いを断ち切る最終決断）」


---


**【🎯 今すぐの統合アクション】**
（※日中：最大2ステップの行動指示 / 夜間・疲労時：今すぐできる単一のワンアクションのみ）
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
あなたはAIシステムの改善を行う「メタ・プロンプトエンジニア」兼「行動心理アナリスト」です。

以下は、過去1週間のユーザーとAI（Shadow Cabinet）のやり取りログです。
各会話は <log_entry> タグで区切られ、日時は <timestamp> に記載されています。
この構造化データを分析し、ユーザーが守れなかった約束、行動できなかった原因、AIの対応の反省点、および「ユーザーの新たな特性」を抽出してください。

【現在の SYSTEM_INSTRUCTION】
${SYSTEM_INSTRUCTION}

【現在の USER_PROFILE】 // ← 現在のプロファイルを渡す
${USER_PROFILE}

【過去1週間のログデータ】
${logText}

【タスク】
1. 今週の主な失敗パターン・課題の要約（3点以内）
2. ユーザーの新たな特性・行動傾向の発見（プロファイルに追記・修正すべきこと）
3. 課題を克服するための、現在の SYSTEM_INSTRUCTION の改修提案
4. ユーザーの特性変化を踏まえた、現在の USER_PROFILE の更新案

以下のフォーマットで出力してください。
---
**【🔄 週間自己改善＆プロファイル更新レポート】**
■ 今週の分析と課題:
■ ユーザー特性の新たな発見（取扱説明書のアップデート）:

■ 更新用 SYSTEM_INSTRUCTION（案）:
\`\`\`text
(ここに改修後の全文)
\`\`\`

■ 更新用 USER_PROFILE（案）:
\`\`\`text
(ここに更新後のプロフィールテキスト)
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