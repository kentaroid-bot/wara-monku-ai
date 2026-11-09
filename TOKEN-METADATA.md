# WARA Devnetの名前と画像

本トークン（生産者クレジット）の表示名を **WARA** とする。日次枠は引き続き「今日の300の枠」で、別のトークンを毎日発行するものではない。MOMIは将来の名前候補であり、今回の実装対象ではない。

| 循環 | 名前 | シンボル | Mint |
|---|---|---|---|
| 通常・JSTの日次 | WARA Devnet | WARA | `747UcNdcvMGB5U25DnR8reBtEf9wUWoajhLHHYWPCoa5` |
| 120秒体験 | WARA Devnet Demo | WARA-DEMO | `7JG3TRXjq4JdaJRZJe1CiA8cXCe7fDWiFmZhi1Kv5Ppa` |

![深い緑に金色の藁の輪](assets/wara-avatar.png)

画像の原本・生成プロンプト・配信方針は[assets/README.md](assets/README.md)。名前・シンボル・JSONのURIはMetaplexのMetadataアカウントに記録し、JSONから画像を参照する。JSONと画像は公開GitHubのraw URLで配信する。

**2026-11-07：両Mintへの登録完了。** [オンチェーン照合記録](deployments/devnet-metadata.json)にMetadataアドレス、登録トランザクション、画像ハッシュを保存。登録前後で供給量・トークン口座・プロトコル状態の一致を確認した。BraveのPhantom（テストネットモード）でも、通常版の藁の輪アイコン、`WARA Devnet`、既存の `90 WARA` 残高を確認済み。120秒体験版はオンチェーン照合済みで、Phantom上の表示は未確認。

## 権限と既存残高

既存Mintをそのまま使う。プログラムの命令3は設定作成者の署名を要求し、Mintに紐づくPDAの署名でMetaplex `CreateV1` を呼ぶ。相手プログラムID、Metadata PDA、Mint、発行権限、System/TokenプログラムとInstructions sysvarを検証する。既存Metadataの上書きはこの命令ではできない。

標準は明示的に `Fungible`、ロイヤリティ0、更新可能なメタデータとする。Metadataの更新権限は既存の専用Devnet設定作成者が持つ。発行権限は従来のプログラムPDAに残し、外部ウォレットへ移さない。更新可能とは表示情報についてであり、この登録処理にトークンの追加発行・凍結・回収機能はない。既存のプログラム更新権限は引き続きDevnet試作の管理者が持つ。

## 再現と確認

通常のビルド・配備は[DEVNET.md](DEVNET.md)を参照。専用Devnet鍵はGit除外の `private/` に保持し、Mainnetや個人の既存鍵を使わない。

```sh
cargo build-sbf -- --locked
# テストで本物のMetaplex CPIを実行するため、Devnet配備バイナリを取得する。
solana program dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s private/metaplex-token-metadata.so --url https://api.devnet.solana.com
npm test
# 画像・JSONを公開GitHubへ保存し、内容を照合してから既存Devnetを更新する。
npm run deploy:devnet
node scripts/register-metadata-devnet.mjs
node scripts/register-metadata-devnet.mjs --check
```

登録スクリプトはDevnet genesis、設定作成者、Mintと発行権限、公開JSON・画像の一致を確認してから送信する。Metadataがすでにあれば内容を検証し、二度作らない。登録前後でMint全データ、同じMintの全トークン口座、プロトコル状態を比較する。同時に他の人が取引した場合も差分として停止するため、その場合は取引履歴を点検する。成功記録は `deployments/devnet-metadata.json` に保存する。`--check` は新しい取引を送らない。

Metaplexバイナリがない環境ではCPIテストは理由付きでskipする。登録・配備前には上記の取得を行い、skipなしの通過を確認する。テストは権限のすり替え・署名欠落・不正な入力・二重作成の拒否、登録前後の状態保持、登録後も日次300を超えられないことを検証する。

名前・画像の登録は、Phantomの「認証済み」扱いや警告の解除を保証しない。ウォレット側の取得・キャッシュ・安全性判定によって表示に時間がかかる場合がある。登録結果とPhantomでの表示確認は分けて記録する。

参照: [Phantomのトークン表示](https://docs.phantom.com/best-practices/tokens/token-display)、[SolanaのMetaplex説明](https://solana.com/docs/tokens/metaplex)、[Metaplex CreateV1](https://github.com/metaplex-foundation/mpl-token-metadata/blob/main/clients/rust/src/generated/instructions/create_v1.rs)。
