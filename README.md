# toshiie-booking

Google カレンダー（＋任意の ICS フィード）の空き時間から、相手が予約枠を選べる日程調整サイト。

**公開URL:** https://toshiie-booking.web.app

- 空き時間は Google Calendar の freeBusy と ICS フィード（例: UTAS の時間割）から算出
- 予約されるとカレンダーに `【予約】名前` の予定を作成（直前に空きを再確認して二重予約を防止）
- 予約完了後、予約者に確認メール（カレンダー招待 `.ics` 添付）を SMTP で送信（`SMTP_HOST` 未設定なら送信しない）
- フロントエンドは Apple Human Interface Guidelines 風のデザイン（ライト / ダーク対応）

## 構成

- `server.js` — Express（API + 静的配信）
- `public/` — フロントエンド（素の HTML / CSS / JS）
- Cloud Run（`asia-northeast1`）+ Firebase Hosting（`*.web.app` のURLで Cloud Run に転送）
- 認証はサービスアカウント。カレンダーをサービスアカウントのメールに「予定の変更」権限で共有して使う

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CALENDAR_ID` | （未設定なら MOCK モード） | 参照・書き込み先のカレンダーID |
| `ICS_URLS` | — | 空き時間の計算に加える ICS の URL（カンマ区切り）。`[休]` で始まる予定は空き扱い |
| `OWNER_NAME` | `Toshs` | ページに表示する名前 |
| `WORK_DAYS` | `0,1,2,3,4,5,6` | 受付する曜日（0=日） |
| `WORK_START` / `WORK_END` | `10:00` / `23:00` | 受付時間 |
| `DURATION_STEP` / `MAX_DURATION` | `30` / `240` | 所要時間の刻みと上限（分） |
| `DAYS_AHEAD` | `14` | 何日先まで表示するか |
| `MIN_NOTICE_HOURS` | `0` | 何時間後以降の枠から予約できるか |
| `SMTP_HOST` | （未設定なら確認メールを送らない） | 確認メールの SMTP サーバー（例: `smtp.gmail.com`） |
| `SMTP_PORT` | `465` | SMTP ポート（465 は SSL、587 は STARTTLS） |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP 認証情報（Gmail は[アプリパスワード](https://myaccount.google.com/apppasswords)を使用） |
| `MAIL_FROM` | `"OWNER_NAME" <SMTP_USER>` | 送信元 |
| `MAIL_BCC` | — | 控えを送るアドレス（任意） |

## ローカル実行

```sh
npm install
npm run dev   # MOCK=1 でダミーの予定を使って起動 → http://localhost:8080
```

## デプロイ

```sh
gcloud run deploy booking --source . --region asia-northeast1 \
  --service-account <SA_EMAIL> --allow-unauthenticated \
  --set-env-vars CALENDAR_ID=<calendar id>,ICS_URLS=<ics url>
```

確認メールを有効にする場合（Gmail の例。パスワードは Secret Manager に置く）:

```sh
printf '%s' '<アプリパスワード>' | gcloud secrets create smtp-pass --data-file=-
gcloud run services update booking --region asia-northeast1 \
  --update-env-vars SMTP_HOST=smtp.gmail.com,SMTP_USER=<gmail address>,MAIL_BCC=<gmail address> \
  --update-secrets SMTP_PASS=smtp-pass:latest
```

サービスアカウントに `roles/secretmanager.secretAccessor` が必要です。
