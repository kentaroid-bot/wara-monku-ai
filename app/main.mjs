import {Buffer} from 'buffer';
import {Connection,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction} from '@solana/spl-token';
import {pk,assertDevnet,readInstance,readPerson,readClock,currentDay,remaining,amount,budgetInstructions,enrollInstruction,paymentInstructions} from './protocol.mjs';
import {createRequest,parseRequest} from './qr-protocol.mjs';
import {withReference,receiptLookup} from './receipt.mjs';
import {historyReader,historySummary} from './receipt-history.mjs';
import {createPaymentHistoryView} from './payment-history-view.mjs';
import {qrImage,createScanner} from './qr-media.mjs';
globalThis.Buffer=Buffer;
const $=id=>document.getElementById(id),RPC='https://api.devnet.solana.com';
const connection=new Connection(RPC,'confirmed');
let manifest,program,config,instance,provider,wallet,person,credit=0n,chainTime=0n,clockReadAt=0,busy=false,generation=0;
let checkoutRequest=null,merchantRequest=null,scanning=false,scanGeneration=0;
let receiptWatch=null;
let merchantHistory=null,historyBusy=false,historyEpoch=0,historyLastAttempt=0,historyAgain=false,historyCache=new Map();
const paymentHistory=createPaymentHistoryView({connection,getContext:()=>wallet&&instance?{payer:wallet,program,config,mint:instance.mint,generation}:null});
const write=(id,text)=>{$(id).textContent=text;};
function notice(text,error=false){write('status',text);$('status').classList.toggle('error',error);}
function usingDaily(){return $('payDaily').checked;}
function showPaymentMethod(){const daily=usingDaily();
 write('paymentExplanation',daily?'あなたの署名で支払いが成立すると、Kusaは300から200へ、相手には100 WARAを新規発行。自分が持っているWARAは減りません。店側の署名は不要です。':'WARAを100持っていて40支払うと、自分は60、相手は40増えます。新規発行なし・今日の枠は変わりません。残高の範囲で300を超える支払いもできます。店側の署名は不要です。');
 if(daily)$('amount').max='300';else $('amount').removeAttribute('max');controls();}
function controls(){paymentHistory.controls();const blocked=busy||scanning,ready=Boolean(wallet&&instance)&&!blocked,confirmed=!checkoutRequest||($('confirmCheckout').checked&&Date.now()<checkoutRequest.expiresAt);for(const id of ['enroll','refresh','refreshReceived','makeRequest'])$(id).disabled=!ready;
 for(const id of ['nextCheckout','nextCheckoutSummary']){const button=$(id);button.hidden=!receiptWatch?.done;button.disabled=!ready||!receiptWatch?.done;}
 for(const id of ['scanRequest','requestFile'])$(id).disabled=blocked||!instance;
 for(const id of ['merchantLabel','requestAmount','recipient','amount','confirmCheckout','clearCheckout'])$(id).disabled=blocked;
 $('refreshHistory').disabled=!wallet||!instance||historyBusy;$('moreHistory').disabled=!wallet||!instance||historyBusy||!merchantHistory||merchantHistory.snapshot().done;
 $('pay').disabled=!ready||!confirmed||(usingDaily()?!person:credit===0n);for(const id of ['payDaily','payCredit'])$(id).disabled=blocked;$('enroll').disabled=!ready||Boolean(person);$('connect').disabled=blocked||Boolean(wallet);$('disconnect').disabled=blocked||!wallet;$('instance').disabled=blocked;}
async function task(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){notice(e.message||String(e),true);}finally{busy=false;controls();}}
function snapshot(){if(!wallet||!instance)throw Error('Phantomと配備済みの循環設定を接続してください。');return {wallet,config,program,generation};}
function unchanged(s){if(s.generation!==generation||!wallet?.equals(s.wallet)||String(config)!==String(s.config))throw Error('ウォレットまたは設定が変わりました。最初からやり直してください。');}
function clearWallet(){generation++;wallet=null;person=null;credit=0n;resetQR();write('wallet','未接続');write('remaining','—');write('credit','—');write('enrollment','');controls();}
async function refresh(){
 const s=snapshot();await assertDevnet(connection);
 const [p,t,b]=await Promise.all([readPerson(connection,program,config,wallet),readClock(connection),connection.getAccountInfo(getAssociatedTokenAddressSync(instance.mint,wallet),'confirmed')]);unchanged(s);
 if(b&&(!b.owner.equals(TOKEN_PROGRAM_ID)||b.data.length!==165||!pk(b.data.subarray(0,32)).equals(instance.mint)||!pk(b.data.subarray(32,64)).equals(wallet)))throw Error('クレジット口座の情報が一致しません。');
 person=p;chainTime=t;clockReadAt=Date.now();credit=b?Buffer.from(b.data).readBigUInt64LE(64):0n;
 write('remaining',person?String(remaining(person,currentDay(t,instance))):'未登録');write('credit',String(credit));
 write('receivedBalance',`現在のWARA残高：${credit}（${instance.period===120n?'120秒体験版':'一日循環'}）。お会計QRへの入金は自動確認の表示をご覧ください。`);
 write('enrollment',person?'参加済み。登録し直しても、その日の枠は増えません。':'参加登録するとKusaを使えます。');
 controls();tick();if(Date.now()-historyLastAttempt>60000)updateHistory();paymentHistory.update();
}
function tick(){if(!instance||!clockReadAt)return;const elapsed=Math.floor((Date.now()-clockReadAt)/1000);if(elapsed>30){write('countdown','更新待ち');write('clocknote','時計が古くなりました。「残高を更新」で再取得');return;}
 const t=chainTime+BigInt(elapsed),seconds=instance.period-(t+instance.offset)%instance.period;write('countdown',`${String(seconds/3600n).padStart(2,'0')}:${String(seconds/60n%60n).padStart(2,'0')}:${String(seconds%60n).padStart(2,'0')}`);write('clocknote',instance.period===120n?'体験用：120秒を一日とします':'日本時間の午前0時更新・表示は推定');
 if(person)write('remaining',String(remaining(person,currentDay(t,instance))));}
function logSignature(sig){const li=document.createElement('li'),a=document.createElement('a');a.href=`https://explorer.solana.com/tx/${sig}?cluster=devnet`;a.target='_blank';a.rel='noopener noreferrer';a.textContent=sig;li.append(a);$('transactions').prepend(li);return li;}
async function broadcast(tx){
 await assertDevnet(connection);if(!tx.verifySignatures())throw Error('必要な署名が揃っていません。');
 // Log the deterministic signature before sending: a network timeout can follow acceptance.
 const sig=await import('bs58').then(m=>m.default.encode(tx.signature));const li=logSignature(sig);
 notice('Devnetへ送信しています。確認が終わるまで同じ支払いを作り直さないでください。');
 try{await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  for(let i=0;i<20;i++){const {value:[s]}=await connection.getSignatureStatuses([sig],{searchTransactionHistory:true});
   if(s?.err){li.append(' · 失敗');throw Error(`チェーンで失敗：${JSON.stringify(s.err)}`);}
   if(s&&['confirmed','finalized'].includes(s.confirmationStatus)){li.append(' · 確認済み');return sig;}
   await new Promise(resolve=>setTimeout(resolve,1500));}
  li.append(' · 確認待ち');throw Error('送信結果は未確定です。リンク先で確認し、残高を更新してください。');
 }catch(e){if(!li.textContent.includes('失敗'))li.append(' · 結果をExplorerで確認');throw Error(`${e.message} 同じ支払いの再作成前に、表示した署名の結果と残高を確認してください。`);}
}
async function signAndSend(instructions,guard=()=>{}){const s=snapshot();await assertDevnet(connection);const latest=await connection.getLatestBlockhash('confirmed');unchanged(s);
 const tx=new Transaction({feePayer:s.wallet,recentBlockhash:latest.blockhash}).add(...budgetInstructions(),...instructions),message=tx.serializeMessage();const signed=await provider.signTransaction(tx);unchanged(s);
 if(!signed.serializeMessage().equals(message))throw Error('署名時に取引内容が変わりました。');guard();return broadcast(signed);}
async function selectInstance(){generation++;instance=null;person=null;clockReadAt=0;resetQR();write('remaining','—');write('credit','—');write('countdown','—');controls();
 const selected=manifest?.instances?.[$('instance').value];if(!manifest?.program||!selected){write('deployment','Devnet未配備です。配備情報が保存されると操作できます。');return;}
 program=pk(manifest.program);config=pk(selected.config);await assertDevnet(connection);instance=await readInstance(connection,program,config);write('deployment',`Devnet · ${instance.period===120n?'120秒体験用':'一日循環'} · Mint ${instance.mint}`);
 if(wallet)await refresh();controls();}
$('connect').onclick=()=>task(async()=>{
 provider=window.phantom?.solana;if(!provider?.isPhantom)throw Error('PCではPhantom拡張のあるブラウザ、スマートフォンではPhantomアプリ内ブラウザで開いてください。');
 provider.removeListener?.('disconnect',clearWallet);provider.on('disconnect',clearWallet);
 provider.removeListener?.('accountChanged',accountChanged);provider.on('accountChanged',accountChanged);
 const result=await provider.connect();wallet=pk(result.publicKey);generation++;write('wallet',wallet.toBase58());if(instance)await refresh();notice('接続しました。');
});
function accountChanged(){clearWallet();notice('アカウントが変更されました。「Phantomに接続」で接続し直してください。');}
$('disconnect').onclick=()=>task(async()=>{await provider?.disconnect();clearWallet();});
$('instance').onchange=()=>task(selectInstance);
$('refresh').onclick=()=>task(async()=>{await refresh();notice('チェーン上の残高を更新しました。');});
$('refreshReceived').onclick=()=>task(async()=>{await refresh();if(receiptWatch)await pollReceipt(receiptWatch,true);});
$('enroll').onclick=()=>task(async()=>{await signAndSend([enrollInstruction(program,config,wallet)]);await refresh();notice('参加登録しました。まだトークンは発行されていません。');});
$('payDaily').onchange=()=>{showPaymentMethod();};
$('payCredit').onchange=()=>{showPaymentMethod();};
$('pay').onclick=()=>task(async()=>{
 await refresh();validateCheckout();const daily=usingDaily(),dest=pk($('recipient').value.trim());
 if(dest.equals(wallet))throw Error('別の支払先を指定してください。');
 const day=currentDay(chainTime,instance);
 if(daily&&!person)throw Error('Kusaを使うには参加登録してください。');
 const value=amount($('amount').value,daily?remaining(person,day):credit);
 const instructions=daily?paymentInstructions(program,config,wallet,dest,value,day,person.nonce).slice(2):[
  createAssociatedTokenAccountIdempotentInstruction(wallet,getAssociatedTokenAddressSync(instance.mint,dest),dest,instance.mint),
  createTransferCheckedInstruction(getAssociatedTokenAddressSync(instance.mint,wallet),instance.mint,getAssociatedTokenAddressSync(instance.mint,dest),wallet,value,0)
 ];
 if(checkoutRequest?.reference)instructions[instructions.length-1]=withReference(instructions.at(-1),checkoutRequest.reference);
 await signAndSend(instructions,validateCheckout);paymentHistory.update(true);clearCheckout();
 notice(daily?`${value} Kusaの支払いが成立しました。枠を消費し、相手に${value} WARAを発行しました。`:`${value} WARAの支払いが成立しました。既存残高から移動し、新規発行はありません。`);
 try{await refresh();}catch{notice('支払いは確認済みですが、残高の再取得に失敗しました。「残高を更新」を押してください。支払いをやり直す必要はありません。',true);}
});
function qrContext(){if(!instance)throw Error('循環設定の読み込みを待ってください。');return {program,config,mint:instance.mint};}
function removeQr(){ $('requestQr').removeAttribute('src');$('saveRequestQr').removeAttribute('href'); }
function setQr(prefix,url){$('requestQr').src=url;$('saveRequestQr').href=url;$('requestCard').hidden=false;}
function clearCheckout(){checkoutRequest=null;$('checkoutReview').hidden=true;$('confirmCheckout').checked=false;$('recipient').readOnly=false;$('amount').readOnly=false;$('recipient').value='';$('amount').value='100';controls();}
function receiptMessage(text,kind='waiting'){
 for(const id of ['receiptStatus','receiptStatusSummary']){write(id,text);$(id).className=`receipt-status ${kind}`;}
}
function stopReceipt(){if(receiptWatch)clearTimeout(receiptWatch.timer);receiptWatch=null;}
function clearMerchant(){stopReceipt();merchantRequest=null;$('requestCard').hidden=true;removeQr();$('receiptLink').hidden=true;write('receiptDetail','');receiptMessage('お会計QRを作ると、入金を自動で確認します。');controls();}
async function pollReceipt(w,manual=false){
 if(receiptWatch!==w||w.pending||w.done)return;
 clearTimeout(w.timer);
 if(document.hidden&&!manual)return;
 if(!manual&&Date.now()>w.request.expiresAt+120_000){receiptMessage('自動確認の時間が終了しました。未受領とは限りません。「残高・入金を再確認」で結果を確認してください。','uncertain');return;}
 w.pending=true;
 try{
  await assertDevnet(connection);const result=await w.check();
  if(receiptWatch!==w)return;
  if(result){
   w.done=true;receiptMessage(`${result.amount} WARA受け取りました`,'received');controls();
   write('receiptDetail',`${result.method==='daily'?'Kusaからの支払い':'WARA残高からの支払い'} · 宛先・金額・お会計番号が一致し、チェーンで確認済み。支払元：${result.payer}`);
   $('receiptLink').href=`https://explorer.solana.com/tx/${result.signature}?cluster=devnet`;$('receiptLink').hidden=false;
   $('requestCard').hidden=true;removeQr();logSignature(result.signature).append(' · 入金確認済み');
   // Preserve success even when a separate balance refresh fails.
   try{await refresh();}catch{}
   if(receiptWatch===w)updateHistory(true);
  }else receiptMessage(Date.now()<w.request.expiresAt?`${w.request.amount} WARAの入金を待っています…`:Date.now()<w.request.expiresAt+120_000?'QRの期限が切れました。送信済みの支払いを引き続き確認しています。':'このお会計への入金はまだ確認できません。自動確認は終了しています。Explorerでも確認してください。');
 }catch{if(receiptWatch===w)receiptMessage('通信または照合の確認待ちです。受取完了ではありません。接続回復後に再確認します。','uncertain');}
 finally{
  w.pending=false;
  if(receiptWatch===w&&!w.done&&!document.hidden){
   if(Date.now()<=w.request.expiresAt+120_000)w.timer=setTimeout(()=>pollReceipt(w),6000);
   else receiptMessage('自動確認の時間が終了しました。未受領とは限りません。「残高・入金を再確認」で結果を確認してください。','uncertain');
  }
 }
}
function startReceipt(request,minSlot){
 stopReceipt();const w={request,check:receiptLookup(connection,request,minSlot),timer:null,pending:false,done:false};receiptWatch=w;
 receiptMessage(`${request.amount} WARAの入金を待っています…`);pollReceipt(w);
}

const receiptTime=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
function resetHistory(){historyEpoch++;merchantHistory=null;historyBusy=false;historyLastAttempt=0;historyAgain=false;historyCache=new Map();$('receiptHistoryRows').replaceChildren();write('todayReceived','—');write('receiptHistoryNote','接続すると、この受取口座の履歴をチェーンから読み込みます。');}
function renderHistory(){
 if(!merchantHistory)return;const state=merchantHistory.snapshot(),summary=historySummary(state,Number(chainTime));
 write('todayReceived',`${summary.total} WARA${summary.complete?'':'（取得済み分）'}`);
 write('receiptHistoryNote',`${receiptTime.format(new Date(Number(chainTime)*1000)).split(' ')[0]} · 日本時間 · 今日${summary.count}件。${summary.complete?'今日の範囲を取得しました。':'今日の全件を取得できていません。「続きを読み込む」で確認してください。'} 受取履歴${state.entries.length}件を表示。`);
 const rows=$('receiptHistoryRows');rows.replaceChildren();
 for(const entry of state.entries){
  const tr=document.createElement('tr');
  const values=[entry.blockTime===null?'時刻不明':receiptTime.format(new Date(entry.blockTime*1000)),`${entry.amount} WARA`,entry.method==='daily'?'Kusa払い':entry.method==='credit'?'WARA払い':'その他の受取'];
  for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  const detail=document.createElement('td');detail.textContent=entry.reference?`お会計 ${entry.reference.slice(0,8)}…`:'お会計番号なし';
  if(entry.reference)detail.title=entry.reference;
  if(entry.payer){const sender=document.createElement('small');sender.textContent=`支払元 ${entry.payer.slice(0,8)}…`;sender.title=entry.payer;detail.append(sender);}tr.append(detail);
  const linkCell=document.createElement('td'),link=document.createElement('a');link.href=`https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`;link.target='_blank';link.rel='noopener noreferrer';link.textContent='取引を見る';linkCell.append(link);tr.append(linkCell);rows.append(tr);
 }
 if(!state.entries.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='取得した範囲に受取はありません。';tr.append(td);rows.append(tr);}controls();
}
async function updateHistory(force=false,more=false){
 if(!wallet||!instance)return;
 if(historyBusy){if(force&&!more)historyAgain=true;return;}
 if(!force&&Date.now()-historyLastAttempt<60000)return;
 const s=snapshot(),epoch=historyEpoch;historyBusy=true;historyLastAttempt=Date.now();controls();
 write('receiptHistoryNote','チェーンの受取履歴を読み込んでいます…');
 try{
  await assertDevnet(connection);const t=await readClock(connection);unchanged(s);if(epoch!==historyEpoch)return;
  chainTime=t;clockReadAt=Date.now();
  const reader=more&&merchantHistory?merchantHistory:historyReader(connection,{program:s.program,config:s.config,mint:instance.mint,recipient:s.wallet},historyCache);
  // At most 100 account transactions per refresh; never present a partial sum as a full daily total.
  let state;for(let i=0;i<(more?1:5);i++){state=await reader.load();unchanged(s);if(epoch!==historyEpoch)return;if(state.done||more||historySummary(state,Number(t)).complete)break;}
  merchantHistory=reader;renderHistory();
 }catch(e){if(epoch===historyEpoch){write('receiptHistoryNote',`履歴の更新を完了できませんでした。${e.message||e} 表示済みの合計は更新前の値です。もう一度更新してください。`);}}
 finally{if(epoch===historyEpoch){historyBusy=false;controls();if(historyAgain){historyAgain=false;updateHistory(true);}}}
}
$('refreshHistory').onclick=()=>updateHistory(true);$('moreHistory').onclick=()=>updateHistory(true,true);

function resetQR(){paymentHistory.reset();resetHistory();scanner.stop();$('qrScanner').close();clearMerchant();clearCheckout();write('receivedBalance','接続中のウォレットと循環設定の残高を確認してください。');}
function validateCheckout(){if(!checkoutRequest)return;parseRequest(JSON.stringify(checkoutRequest),qrContext());
 if(!$('confirmCheckout').checked||$('recipient').value!==checkoutRequest.recipient||$('amount').value!==checkoutRequest.amount)throw Error('QRの宛先と金額をもう一度確認してください。');}
function readQr(raw){
 if(scanGeneration!==generation)throw Error('ウォレットや設定が変わりました。QRを読み直してください。');
 clearCheckout();const request=parseRequest(raw,qrContext());
 if(wallet?.equals(pk(request.recipient)))throw Error('自分への支払いはできません。別の店のお会計QRを読んでください。');
 checkoutRequest=request;$('recipient').value=request.recipient;$('amount').value=request.amount;$('recipient').readOnly=true;$('amount').readOnly=true;
 write('checkoutSummary',`${request.label||'受取人'}（表示名は未確認）へ ${request.amount} WARA相当。宛先：${request.recipient}。店頭の相手と金額を確認してください。`);$('checkoutReview').hidden=false;
 notice('宛先と金額が入りました。確認欄にチェックし、支払い方法を選んで「支払う」を押してください。');$('qrScanner').close();controls();
}
const scanner=createScanner({video:$('qrVideo'),canvas:$('qrCanvas'),onValue:readQr,
 onStatus:message=>{scanning=Boolean($('qrVideo').srcObject)||message.includes('許可を確認');write('scannerStatus',message);controls();},
 onStop:()=>{scanning=false;controls();}});
function startScan(kind){return task(async()=>{scanGeneration=generation;write('scannerTitle','店側のお会計QRを読む');$('qrScanner').showModal();try{await scanner.start(kind);}catch(e){write('scannerStatus',e.message);throw e;}});}
$('scanRequest').onclick=()=>startScan('request');
$('stopScanner').onclick=()=>{$('qrScanner').close();scanner.stop();};$('qrScanner').addEventListener('close',()=>scanner.stop());
document.addEventListener('visibilitychange',()=>{if(document.hidden){scanner.stop();$('qrScanner').close();if(receiptWatch)clearTimeout(receiptWatch.timer);}else if(receiptWatch)pollReceipt(receiptWatch);});window.addEventListener('pagehide',()=>{scanner.stop();if(receiptWatch)clearTimeout(receiptWatch.timer);});window.addEventListener('pageshow',()=>{if(receiptWatch)pollReceipt(receiptWatch);});
for(const [id,kind] of [['requestFile','request']])$(id).onchange=()=>{const file=$(id).files[0];$(id).value='';task(async()=>{scanGeneration=generation;await scanner.file(file,kind);});};
$('makeRequest').onclick=()=>task(async()=>{const s=snapshot();clearMerchant();await assertDevnet(connection);const minSlot=await connection.getSlot('confirmed');unchanged(s);const raw=createRequest(qrContext(),wallet,$('requestAmount').value,$('merchantLabel').value),data=parseRequest(raw,qrContext()),image=await qrImage(raw);unchanged(s);merchantRequest=data;setQr('request',image);write('requestSummary',`${data.label||'あなた'}へのお会計：${data.amount} WARA相当 · ${instance.period===120n?'120秒体験版':'一日循環'}`);qrTick();startReceipt(data,minSlot);notice('お会計QRを作りました。この画面を開いたまま、買う人に読み取ってもらってください。入金を自動確認します。');});
for(const id of ['merchantLabel','requestAmount'])$(id).oninput=clearMerchant;
function nextCheckout(){
 if(busy||scanning||!wallet||!instance||!receiptWatch?.done)return;
 clearMerchant();$('requestAmount').value='';
 receiptMessage('次のお客さんの金額を入力して、お会計QRを作ってください。');
 $('checkout').scrollIntoView({block:'start'});$('requestAmount').focus({preventScroll:true});
 notice('次のお会計を準備しています。店名・受取先はそのままです。前の入金は操作の記録に残っています。');
}
$('nextCheckout').onclick=nextCheckout;$('nextCheckoutSummary').onclick=nextCheckout;
$('clearCheckout').onclick=clearCheckout;$('confirmCheckout').onchange=controls;
function qrTick(){const now=Date.now();if(merchantRequest&&!receiptWatch?.done){const remaining=Math.ceil((merchantRequest.expiresAt-now)/1000);if(remaining<=0){$('requestCard').hidden=true;removeQr();}else write('requestExpiry',`お会計QRの残り時間 ${Math.floor(remaining/60)}分${remaining%60}秒`);}
 if(checkoutRequest&&now>=checkoutRequest.expiresAt){write('checkoutSummary','お会計QRの期限が切れました。店側で新しく作ったQRを読み直してください。');$('confirmCheckout').checked=false;}
 controls();}
setInterval(()=>{tick();qrTick();},1000);
setInterval(()=>{if(wallet&&instance&&!busy&&!scanning)task(refresh);},20000);
task(async()=>{const response=await fetch('/devnet/deployment.json',{cache:'no-store'});if(!response.ok)throw Error('配備情報を取得できません。');manifest=await response.json();if(manifest.cluster!=='devnet'||manifest.rpc!==RPC)throw Error('Devnet以外の設定を拒否しました。');await selectInstance();});
