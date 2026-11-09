# wara.monku.ai · 藁一本の約束 v0.3

「今日食べるための枠と、届けた人に残る対価」を地域の財布と店舗レジで試すSolana Devnetアプリです。このリポジトリでサイトの実装とCloudflare Workersへの配備を管理します。[構想とオフラインモック](https://github.com/kentaroid-bot/emergency-straw-protocol)

[お財布を開く](https://wara.monku.ai/) · [コミュニティ](https://wara.monku.ai/communities/) · [旧Devnet検証版](https://wara.monku.ai/devnet/)

使わなかったKusaは翌日に残りません。店で使うと、その時だけWARAが生まれます。たとえば毎日10 Kusaの枠から5枚で支払うと、残りは5 Kusa。店には450 WARA、お客さんには50 WARAが届きます。WARAで次の買い物をすると、新たに発行せず、同じ発行元のトークンが移動します。

## 試し方

1. トップから登録。「SMSで確認コードを受け取る」と表示される場合は、ご自身の番号でSMSを受け取って入力します。「確認コードを表示する」と表示される試験環境では、架空の番号を使います。組み込みウォレット、Phantom、地域窓口での紙カード発行を選べます。
2. 新規登録時の10 Kusaは支払い枠です。登録だけでトークンは発行しません。Devnetで初めて署名する前に「アカウント」で公開アドレスを確認し、[無料のテストSOL](https://faucet.solana.com/)を用意します。MainnetのSOLは使いません。
3. [みどり商店街](https://wara.monku.ai/communities/?id=J9PGMWgkXXH2dhoZpdGtNyRA2xbtmLJPM4SnGWMvE3wC)などの自由参加の地域に参加して、公認店舗のレジを開きます。支払いは本人のウォレットが署名し、確定後にExplorerの取引リンクが出ます。店は自分のレジで会計QRを表示できます。
4. [コミュニティを開設](https://wara.monku.ai/communities/new/)すると開設者が管理者になります。自由参加・招待コード・承認制から選び、店名と受取ウォレットを公認します。地域同士で申請・承認すると、双方の店が相手のWARAを額面どおり受け入れます。

## どこに記録されるか

Devnetプログラムは、地域・管理者・店舗・参加状態・双方向の提携を保持します。1地域1ミント。店も本人も同じ発行元のWARAを受け取り、他の地域で使っても発行元は変わりません。Kusaの使用量は地域をまたいでウォレットごとに合計し、日本時間0時に更新します。使用量と二口の発行は同じ取引で確定し、どれかが失敗すれば全部取り消されます。

[静的なSites版](https://straw-promise-devnet.kentaroid.chatgpt.site/)は、組み込み・紙カード用の鍵をパスワードで暗号化して発行ブラウザに保存します。Cloudflare Workers版では、登録した電話番号と同じパスワードで別端末から同じ財布を開けます。Phantomを選んだ方は、登録したウォレットでメッセージに署名します。実SMSモードでは登録時とサインイン時に電話番号の所持を確認します。画面にコードを表示する試験モードの登録は、実SMSによる確認とは別に扱います。紙のQRに含むのは公開アドレスで、紙だけでは署名できません。現物受け渡しの証明、端末のない人の代理署名、本番資産はこの版の対象外です。

## フォークして動かす

Node.js 24、AgaveのSBFビルドツールを用意して次を実行します。

```sh
npm ci
cargo build-sbf -- --locked
npm test
npm run build
npm start
```

[localhost:8787](http://127.0.0.1:8787/) を開きます。静的サイトの配布は `dist/` のみ。Workers版の起動と独自ドメインの設定は[配備手順](HOSTING.md#cloudflare-workers-版)にあります。Solanaの接続先はDevnetに固定し、署名前にgenesis hashを照合します。旧300枠は別命令・別ミントで [/devnet/](https://wara.monku.ai/devnet/) に残しています。[旧仕様の資料](LEGACY-v02.md)・[初期構想](https://github.com/kentaroid-bot/emergency-straw-protocol/blob/main/DESIGN.md)・[配備手順](HOSTING.md)。MIT。
