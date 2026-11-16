export function showGuide(el) {
  el.innerHTML = `<h1>使い方</h1>
    <section class="guide-intro"><h2>iineのお財布</h2>
      <p>日常の「いいね」を、誰かへの「ありがとう」に。毎日届く <strong>10 iine</strong> で、家族や仲間へ気軽に感謝を贈れます。</p>
      <dl><dt>👍 今日の iine</dt><dd>今日、誰かに贈るための10個のいいね。複数のコミュニティに参加しても、ひとつの財布で毎日合計10 iineです。</dd>
      <dt>🌾 WARA — ありがとうの結晶</dt><dd>1 iineを贈ると、<strong>相手に100 WARA</strong>が届きます。贈る人への還元はありません。WARAは日付が変わっても残ります。</dd></dl>
    </section>
    <section class=paper-card><h2>毎日 0:00（JST）にリセット</h2>
      <p>使い切れなかった iine は<strong>日本時間 0:00</strong>にリセットされ、新しい <strong>10 iine</strong> が届きます。前日の残りは繰り越しません。積み上がった <strong>WARAは消えずに残ります。</strong></p>
    </section>
    <section class=paper-card><h2>👍 iineを贈る</h2><ol class="guide-steps">
      <li>お財布の左上の茶色いキャラやハートを押して、相手を選びます。相手の受け取りQRを読み取っても開けます。</li>
      <li>大きな赤いハートをタップ。3 iineなら3回タップすると、ハートが大きくなり、赤い丸が3つ並びます。「−」で1つ減らし、「↺」でやり直せます。効果音はON/OFFを切り替えられます。</li>
      <li>「✎」から任意でひとことを添え、選んだ数字の赤い丸ボタンを押します。相手と枚数を確認して確定すると、ありがとうが届きます。絵文字は公開台帳に、ひとことは相手に届きます。</li>
    </ol><p>持っているWARAも、対応する相手に「🌾」ボタンから贈れます。</p></section>
    <section class=paper-card><h2>🌾 受け取る</h2><ol class="guide-steps">
      <li>お財布の右下の緑のキャラから「受け取る」を開きます。窓口が複数ある場合は、自分の受け取り名を選びます。</li>
      <li>表示された受け取りQRを相手に見せます。「おまかせ（枚数指定なし）」なら相手が枚数を選べます。1・3・5、または1〜10の枚数指定もできます。</li>
      <li>画面を開いている間は着金を確認します。届いたありがとうは履歴でも確認できます。</li>
    </ol></section>
    <section class=paper-card><h2>コミュニティで始める</h2><p><a href="/communities/">コミュニティ</a>に参加するか、新しく開設します。受け取り窓口の開設を申請し、管理者の公認を受けると受け取りQRを出せます。管理者は自分や仲間の受け取り名・公開アドレスを登録できます。</p></section>
    <section class=paper-card><h2>携帯をお持ちでない方へ</h2><p>電話番号を登録した家族や知人に、<a href="/account/">アカウント</a>の「家族・知人の財布を作る」から紙のiineカードを発行してもらえます。受け取る人は受け取りQR画面の「⋯」メニューから「📷 紙カードを読み取る（カメラ起動）」を押して、カメラや写真でカードを読み取ります。暗証番号はカードの持ち主本人が入力します。</p></section>
    <section class=paper-card><h2>試験中のお財布について</h2><p>Solana Devnetの試験です。実際のお金は使いません。手数料支援が有効なら、対応する操作に手数料用SOLは不要です。自費の操作にはDevnet SOLを使います。</p><p class="guide-links"><a href="/devnet/">旧Devnet検証版</a><a href="https://github.com/kentaroid-bot/emergency-straw-protocol">この仕組みの原案</a></p></section>`;
}
