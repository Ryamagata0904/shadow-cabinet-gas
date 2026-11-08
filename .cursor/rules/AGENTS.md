# Shadow Cabinet GAS - Agent Guidelines

## プロジェクト概要
ユーザー（山縣 亮）の習慣形成・自己管理を支援する AI 内閣システム「Shadow Cabinet」の Google Apps Script (GAS) バックエンドプロジェクト。
対話ログを蓄積し、Gemini による週次メタレビューを経て GitHub PR 経由で自律的にプロンプトを改善・自動デプロイする自己改善ループを備えている。

## ディレクトリ構成と役割
- `Code.ts`: Google Chat Webhook 受信、Gemini API 連携、対話ログ記録、週次レビュー実行、GitHub API (PR起票) を担う主ロジック。
- `Prompts.ts`: `SYSTEM_INSTRUCTION`（内閣エージェント群の振る舞い定義）および `DEFAULT_USER_PROFILE`（ユーザーの行動特性・NG/成功パターン）の定数定義。
- `.github/workflows/deploy.yml`: `main` ブランチへのプッシュ・マージをトリガーに clasp push を行う CI/CD 定義。
- `appsscript.json`: GAS のマニフェスト（タイムゾーン、OAuth スコープ、Chat 拡張設定）。
- `.clasp.json`: プッシュ先 GAS プロジェクトの識別設定（Git 管理対象）。

---

## 開発・コーディング制約（厳守）

### 1. GAS 実行環境の制約
- **ES Modules の全面禁止**:
  - `export` や `import` キーワードは絶対に使用しないこと（GAS ランタイムで構文エラーになる）。
  - 各ファイルで宣言されたトップレベルの定数・関数は、プロジェクト全体でグローバルに共有される。
- **Node.js / ブラウザ固有 API の禁止**:
  - `fs`, `path`, `fetch`, `window` 等は存在しない。
  - 外部通信: `UrlFetchApp.fetch()`
  - 設定値・秘密情報: `PropertiesService.getScriptProperties()`
  - ドライブ操作: `DriveApp`
  - 日付・文字列操作: `Utilities`

### 2. コード変更時のルール
- **ロジックとプロンプトの分離**:
  - 指示プロンプトやユーザープロファイルの改修は、すべて `Prompts.ts` 側で行う。
  - `Code.ts` は通信や状態管理、GitHub API 連携などの実行ロジックのみを扱う。
- **型定義と構文**:
  - `@types/google-apps-script` に準拠した TypeScript で記述する。
  - トランスパイルエラーを防ぐため、過度に複雑な型パズルは避け、堅牢でシンプルな記述を保つ。

---

## 運用・デプロイプロトコル
- 本番反映は **GitHub Actions 経由** で行う。
- コード修正時は、ローカルでの直接 `clasp push` ではなく、Git コミット ➔ `main` ブランチへのプッシュ（または PR マージ）によって GitHub Actions を起動させる。