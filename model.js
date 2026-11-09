/* MIT. In-memory concept simulation; no authentication or real settlement. */
(function (root) {
  'use strict';
  const DAY = 86400;
  const create = () => ({seconds: 8 * 3600, day: 1, daily: 300, fixed: 0, supplier: 0,
    expired: 0, issued: 300, crystallized: 0, pending: null, lastReceipt: null, seq: 0,
    events: ['DAY 1 · 今日の受給枠 300 pt を配りました。']});
  function log(s, text) { s.events.unshift(`DAY ${s.day} · ${text}`); }
  function advance(s, seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw Error('時間は正の整数で指定してください。');
    const target = s.seconds + seconds;
    if (!Number.isSafeInteger(target) || target > DAY * 10000) throw Error('デモの時間上限です。');
    const newDay = Math.floor(target / DAY) + 1;
    if (newDay > s.day) {
      const days = newDay - s.day;
      const lost = s.daily + (days - 1) * 300;
      s.expired += lost;
      s.issued += days * 300;
      s.daily = 300;
      if (s.pending) { log(s, `${s.pending.id} は未受領のまま期限切れ。`); s.pending = null; }
      s.day = newDay;
      log(s, `未使用 ${lost} pt が失効。新しい一日分 300 pt を配りました。固定残高は保持。`);
    }
    s.seconds = target;
    return s;
  }
  function amount(n) {
    if (!Number.isSafeInteger(n) || n <= 0) throw Error('1以上の整数を入力してください。');
  }
  function offer(s, n, transport) {
    amount(n);
    if (s.pending) throw Error('先に受領するか、取引を取り消してください。');
    if (n > s.daily) throw Error('今日の受給枠を超えています。');
    if (!['QR', 'BLE', 'PAPER'].includes(transport)) throw Error('未対応の受け渡しです。');
    s.pending = {schema: 'straw-demo/1', id: `DEMO-${s.day}-${++s.seq}`, day: s.day,
      from: 'consumer-demo', to: 'producer-demo', amount: n, transport,
      expiresAt: s.day * DAY, signed: false, simulation: true, is_crystallized: false};
    log(s, `${n} pt の受け渡しを準備（${transport}の模擬操作）。まだ固定化されていません。`);
    return s.pending;
  }
  function accept(s, id) {
    const p = s.pending;
    if (!p || p.id !== id) throw Error('受領できる取引がありません。再受領はできません。');
    if (p.expiresAt <= s.seconds || p.day !== s.day) throw Error('この受給枠は期限切れです。');
    s.daily -= p.amount; s.fixed += p.amount; s.crystallized += p.amount;
    s.lastReceipt = {...p, is_crystallized: true, acceptedAt: s.seconds};
    s.pending = null;
    log(s, `食料を手渡して ${p.amount} pt を受領。対価が固定化されました（ローカル模擬台帳）。`);
  }
  function cancel(s) { s.pending = null; log(s, '受け渡しを取り消しました。残高は変わりません。'); }
  function transfer(s, n) {
    amount(n);
    if (n > s.fixed) throw Error('生産者の固定残高が足りません。');
    s.fixed -= n; s.supplier += n;
    log(s, `生産者から資材店へ ${n} pt を移転。固定化された総額は増えません。`);
  }
  const api = {DAY, create, advance, offer, accept, cancel, transfer};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Straw = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
