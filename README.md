# くらしのレシート v0.4（初期 OCR 対応）

**対象**: Android / Windows PWA、個人用Supabase家計簿。GitHub Pages `https://highllows-stack.github.io/receipt-ledger/`。

## 公開前に（必須）

1. Supabase の `receipt-ledger` プロジェクトで SQL Editor を開き、`ocr-setup.sql` を全て貼り付けて Run。過去の購入履歴は削除しません。
2. Supabase Edge Functions → Functions → Deploy a new function → Via Editor。関数名は厳密に `receipt-ocr`。
3. エディタにある既存コードをすべて削除し、`receipt-ocr-edge-function.ts` の全文を貼り付けて **Deploy function**。
4. Edge Functions → Secrets に `GOOGLE_VISION_API_KEY` が保存されていることを確認（値を公開しない）。
5. 本ZIPのうち `index.html`, `app.js`, `cloud.js`, `ocr-parser.js`, `receipt.js`, `sw.js`, `style.css`, `manifest.webmanifest`, `README.md`, アイコン類を GitHub `highllows-stack/receipt-ledger` リポジトリにアップロード（同名ファイルは置換）。`receipt-ocr-edge-function.ts` と `ocr-setup.sql` は、誤操作を避けるため GitHub Pages の公開ルートには置かないでください（これらには秘密鍵はありませんが、設定用ファイルです）。
6. GitHub Pages で v0.4 の画面が表示されたら、テスト用のレシートを1枚読み取る。アプリの「設定」からSupabaseにログインしておいてください。

## 今回できること

- 画像からGoogle Cloud Vision経由で文字読み取り（ログイン必須）
- 画像の複数選択、順番に処理、商品明細の自動登録
- レシートOCRのヒューリスティックな解析（商品名・税込金額、日付、店舗、合計）
- 不整合時に要確認として登録（OCRが少なくとも商品1件と金額を抽出できた場合）
- 同一のOCR文字列からの重複登録の抑止
- 月間API呼び出し件数制限（本人100回、全体500回）
- 画像はSupabase Storageに保存しない。Edge Functionは文字列だけを返す

## 現時点の制限・注意

- OCR抽出は試験実装です。価格、店舗、日付、分類の誤認識があり得ます。自動保存されるため、登録後に履歴を確認してください。
- 値引・税・ポイント・クーポン・バーコードなどの処理は未完成です。「要確認」の購入履歴は実際の合計と違う可能性があります。
- OCRに失敗して1商品も抽出できなかった画像はクラウド登録されず、画像キューにエラー表示が残ります。選択解除またはブラウザ再起動でキューは消えます。
- レシート画像は持続的に保存しません。以前相談した「画像を30日保存して自動削除」はこの版では未実装です。
- Cloud Visionの請求先設定とAPIキーの許可設定が必要です。Google Cloudの予算アラートは課金停止機能ではありません。Google側の他のプロジェクト・キーでの利用回数は、このアプリでは制御できません。
- SQLの回数制限は月ごとにリセットされます。処理失敗でも回数消費する安全側の設計です。
- Edge Functionの接続先サイトは `https://highllows-stack.github.io` に限定されています。別サイトへ移転する際はCORS設定の変更が必要です。
- 同期や共有メンバー招待など旧版の制限は継続します。既存のSupabase購入履歴を消去する処理はありません。

## 開発/配置上の注意

- `GOOGLE_VISION_API_KEY` やSupabase Secret/service_roleはGitHubにコミットしない。
- `receipt-ocr-edge-function.ts` はサーバー側の機能。ファイルをGitHub Pagesに置いても実行されません。
- Supabaseの初期スキーマ `receipt-ledger-supabase-setup.sql` は再実行しない（既存ポリシー重複のおそれ）。v0.4の `ocr-setup.sql` だけ実行します。
- 既存データを扱う前にアプリ設定画面から JSON バックアップを保管しておきます。
