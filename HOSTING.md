# 公開Webと再ビルド

v0.3: トップは登録・財布。/shop/、/support/、/account/、/communities/new/ は同じ公開アプリです。配信パッケージは dist/ のみ。オンチェーンの検証にはビルド前に cargo build-sbf -- --locked と npm test を実行します。

旧版の記録：お会計QR v2のreferenceによる入金自動確認を追加。confirmed取引の宛先・金額・実増加額を照合して受取完了を表示。既存ProgramとMintは変更なし。

2026-11-07更新：買う人だけの署名で支払いを直接送信する版。店側の受領署名・返送QRを削除し、「3. 着金を確認する」に変更。現在の検証は[DEVNET.md](DEVNET.md)と[一者署名版のPhantom実測](deployments/phantom-single-signer.json)を参照。下記の初回公開時の二者署名検証は履歴として残す。

静的な [Sites 版](https://straw-promise-devnet.kentaroid.chatgpt.site/) も公開しています。

静的なSitesホスティング。URLを知る人がChatGPTログインなしで閲覧できる。トランザクションはブラウザのPhantomで署名してSolana Devnetへ送る。サーバーの発行鍵・ウォレット鍵・データベース・RPCプロキシは持たない。

## Cloudflare Workers 版

`wara-monku-ai` はアプリを `dist/` から、同じオリジンの `/api/*` を Worker から配信します。Solana の接続先は Devnet です。[公開アプリ](https://wara.monku.ai/)

### ローカル起動

Node.js 24 で、初回は次を実行します。ローカル専用の秘密は一度だけ生成し、その後も同じ値を使います。

```sh
npm ci
npm run build
(umask 077; test -f .dev.vars || node -e 'console.log("AUTH_PEPPER=" + require("node:crypto").randomBytes(32).toString("hex"))' > .dev.vars)
npm run workers:migrate:local
npm run workers:dev
```

端末に表示されたローカル URL の `/signup/` で架空の電話番号を登録します。別のブラウザで同じ URL を開き、「サインイン」から同じ番号とパスワードを入力すると、アカウント画面に同じ公開アドレスが表示されます。Phantom の場合は同じアカウントで署名します。ローカル D1 は `.wrangler/state/` に残ります。`npm run workers:build` で、アセットとバインディングを含む配備の dry-run ができます。

### 登録データと引き継ぎ

| API | 処理 |
| --- | --- |
| `POST /api/auth/challenge` | 正規化した番号のハッシュと用途を受け取り、5分有効の試験コードと一度限りのチャレンジ ID を返す。 |
| `POST /api/auth/activate` | コードと署名を検証して、番号に対応する財布を一度だけ登録する。既存の登録は上書きできない。 |
| `POST /api/auth/signin` | コードに加えてパスワード由来の鍵、または登録済み Phantom の署名を検証し、保存したプロフィールを返す。 |

組み込み・紙カードではブラウザが秘密鍵を AES-GCM で暗号化します。復号鍵とサインイン署名鍵は別々のソルトで、パスワードから PBKDF2-SHA256（各60万回）で導出します。Worker に渡るのは番号ハッシュ、公開鍵、署名、暗号化済みの Vault です。D1 の番号検索キーはサーバー秘密を使った HMAC です。Phantom の秘密鍵は Phantom が保持します。パスワードを失った場合、画面の確認コードだけでは財布を復元できません。

同じオリジンで静的版を Workers 版へ更新した場合は、元の端末で「この端末の財布を引き継ぐ」を選べます。公開中の Sites と独自ドメインではブラウザの保存領域が異なります。Sites にだけある組み込み財布は独自ドメインに自動移行されません。静的 Sites では引き続き端末内登録を使います。Worker の通信障害時はエラーを表示して再試行できます。

### 独自ドメインへの配備時

1. `wrangler.toml` で `wara.monku.ai` を Worker の Custom Domain に指定しています。Cloudflare がこのホストの DNS と TLS 証明書を管理します。併記した専用ルート `wara.monku.ai/*` をゾーン共通の `*.monku.ai/*` より優先し、アプリと API を同じ Worker に届けます。
2. 公開環境の D1 と `database_id` は設定済みです。別環境を初めて作る場合は、専用の D1 を用意してその UUID を設定します。`npx wrangler d1 migrations apply DB --remote` でスキーマを適用します。
3. 公開環境の `AUTH_PEPPER` は登録済みです。新しい環境の初回にだけ専用乱数を生成し、Cloudflare の暗号化された Worker Secret として設定します（CLI は `npx wrangler secret put AUTH_PEPPER`）。番号検索に必要なため、安全に保管してください。DB の移行を伴わない変更・紛失は既存財布へのサインインに影響します。
4. `npm run workers:build` で確認し、公開する時点で `npx wrangler deploy` を実行します。既定の `AUTH_MODE=disabled` では認証 API は 503 を返します。架空番号を使う Devnet 試験を明示的に公開する場合だけ `npx wrangler deploy --var AUTH_MODE:trial` を使います。
5. 公開先の `/api/auth/status` と `/signup/` を確認し、別ブラウザで登録・復元した公開アドレスを照合します。

確認コードの画面表示は電話番号の所有確認を行いません。試験中は他人が先に番号を登録できます。実番号の運用には SMS 配信と所有確認の実装が必要です。

## 配備元と既存URL

wara.monku.ai の配備元は kentaroid-bot/wara-monku-ai の main。リポジトリ直下でビルドし、公開中の試験環境へは `npx wrangler deploy --var AUTH_MODE:trial` で配備します。静的アセットには明示的に選んだ dist/ 内のファイルだけを含めます。

/mock/ は初期モックの同梱版です。[モックの原本](https://github.com/kentaroid-bot/emergency-straw-protocol)を更新した際は、必要に応じて同梱版へ取り込みます。既発行トークンが参照する旧GitHubのJSONと画像は旧URLを維持します。新規登録用のメタデータは本リポジトリの assets/ で管理します。

従来の静的Sites版の[配備記録](https://github.com/kentaroid-bot/emergency-straw-protocol/blob/4d712647707622a5b8acb11c4f5289199c46e71f/HOSTING.md)は分離前の版を参照してください。

## 公開版の検証範囲

2026-11-07：ビルド成功・18テスト成功。公開HTTPSで通常版のDevnet設定を読み込めることをブラウザで確認。公開ドメインでPhantomを接続し、前日のクレジット90を維持したまま新しい日の枠300を表示することを確認。登録・署名・受領・譲渡の実機検証は2026-11-06の同じプログラムと署名処理で実施済み。公開ドメインで新たな支払署名は行っていない。モバイル実機検証も別に扱う。
