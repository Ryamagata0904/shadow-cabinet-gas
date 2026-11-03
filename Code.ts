/**
 * 週次メタレビューを実行し、GitHub に改善 PR を自動作成する
 */
function runWeeklyMetaReview() {
  const logDocId = PropertiesService.getScriptProperties().getProperty('LOG_DOC_ID');
  const geminiApiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const userProfile = PropertiesService.getScriptProperties().getProperty('USER_PROFILE') || DEFAULT_USER_PROFILE;

  if (!logDocId || !geminiApiKey) {
    console.error("必要なプロパティが不足しています。");
    return;
  }

  try {
    const file = DriveApp.getFileById(logDocId.trim());
    const logText = file.getBlob().getDataAsString();

    if (!logText || logText.trim() === '<?xml version="1.0" encoding="UTF-8"?>\n<logs>') {
      console.log("新しいログがないためレビューをスキップしました。");
      return;
    }

    // 1. Gemini による分析と改善コード生成
    const metaPrompt = `
あなたはAI改善を行うメタエンジニアです。過去1週間の対話ログを分析し、
SYSTEM_INSTRUCTION と USER_PROFILE の改善版を作成してください。

【現在の SYSTEM_INSTRUCTION】
${SYSTEM_INSTRUCTION}

【現在の USER_PROFILE】
${userProfile}

【対話ログ】
${logText}

【出力指示】
Prompts.ts の完全な置き換えコードのみを出力してください。
コード以外の前置きや解説は一切出力せず、\`\`\`typescript や \`\`\` などのコードブロック記号も含めないでください。
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: metaPrompt }] }]
    };
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': geminiApiKey },
      payload: JSON.stringify(payload)
    };

    // @ts-ignore
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    let newPromptsContent = json?.candidates?.[0]?.content?.parts?.[0]?.text;

    // 前後の余計なマークダウンバッククォートを除去
    newPromptsContent = newPromptsContent.replace(/^```typescript\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim();

    // 2. GitHub に PR を自動作成
    const prUrl = createGithubPullRequest(newPromptsContent);

    // 3. Google Chat に通知
    sendChatNotification(`🔄 **【Shadow Cabinet 週間自己改善PRが作成されました】**\n今週の対話からプロンプトとプロフィールの改善案を生成しました。\n以下のリンクから差分（Diff）を確認し、[Merge] を押すと自動反映されます。\n🔗 ${prUrl}`);

    // 4. ログ初期化とアーカイブ
    saveWeeklyArchive(logText);
    file.setContent('<?xml version="1.0" encoding="UTF-8"?>\n<logs>\n');

  } catch (e: any) {
    console.error("週次レビュー失敗: " + e.toString());
    sendChatNotification("⚠️ 週次レビューでエラーが発生しました: " + e.toString());
  }
}

/**
 * GitHub API を使ってブランチ作成 ➔ ファイルコミット ➔ PR 起票を行う内部関数
 */
function createGithubPullRequest(newFileContent: string): string {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER');
  const repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO');

  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GAS-Auto-PR'
  };

  const nowStr = Utilities.formatDate(new Date(), "JST", "yyyyMMdd-HHmmss");
  const branchName = `auto-prompt-${nowStr}`;

  // 1. main ブランチの最新 SHA を取得
  const refRes = UrlFetchApp.fetch(`[https://api.github.com/repos/$](https://api.github.com/repos/$){owner}/${repo}/git/ref/heads/main`, { headers });
  const mainSha = JSON.parse(refRes.getContentText()).object.sha;

  // 2. 新しい改善ブランチを作成
  UrlFetchApp.fetch(`[https://api.github.com/repos/$](https://api.github.com/repos/$){owner}/${repo}/git/refs`, {
    method: 'post',
    headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: mainSha
    })
  });

  // 3. 対象ファイル（Prompts.ts）の現在の SHA を取得
  const fileRes = UrlFetchApp.fetch(`[https://api.github.com/repos/$](https://api.github.com/repos/$){owner}/${repo}/contents/Prompts.ts?ref=main`, { headers });
  const fileSha = JSON.parse(fileRes.getContentText()).sha;

  // 4. 新ブランチ上で Prompts.ts を更新コミット
  const base64Content = Utilities.base64Encode(newFileContent, Utilities.Charset.UTF_8);
  UrlFetchApp.fetch(`[https://api.github.com/repos/$](https://api.github.com/repos/$){owner}/${repo}/contents/Prompts.ts`, {
    method: 'put',
    headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      message: `feat(prompt): weekly self-improvement update (${nowStr})`,
      content: base64Content,
      sha: fileSha,
      branch: branchName
    })
  });

  // 5. Pull Request を作成
  const prRes = UrlFetchApp.fetch(`[https://api.github.com/repos/$](https://api.github.com/repos/$){owner}/${repo}/pulls`, {
    method: 'post',
    headers,
    contentType: 'application/json',
    payload: JSON.stringify({
      title: `🔄 【自動改善】週次プロンプト＆プロファイル更新 (${nowStr})`,
      head: branchName,
      base: 'main',
      body: `過去1週間の対話ログに基づき、Gemini が自動生成した \`Prompts.ts\` の改善案です。\nFiles changed から差分を確認し、問題なければ **Merge pull request** を押してください。自動デプロイが走ります。`
    })
  });

  const prJson = JSON.parse(prRes.getContentText());
  return prJson.html_url;
}