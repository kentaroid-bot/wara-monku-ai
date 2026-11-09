import {assertDevnet,readClock} from './protocol.mjs';
import {paymentHistoryReader,paymentSummary} from './payment-history.mjs';

export function createPaymentHistoryView({connection,getContext}){
 const $=id=>document.getElementById(id),write=(id,text)=>{$(id).textContent=text;};
 const time=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 let reader=null,busy=false,epoch=0,lastAttempt=0,again=false,cache=new Map();
 function controls(){const ready=Boolean(getContext());$('refreshPayments').disabled=!ready||busy;$('morePayments').disabled=!ready||busy||!reader||reader.snapshot().done;}
 function reset(){epoch++;reader=null;busy=false;lastAttempt=0;again=false;cache=new Map();$('paymentHistoryRows').replaceChildren();for(const id of ['todaySpent','todayDailySpent','todayWaraSpent'])write(id,'—');write('paymentHistoryNote','接続すると、このウォレットの支払い履歴をチェーンから読み込みます。');controls();}
 function render(now){
  const state=reader.snapshot(),sum=paymentSummary(state,now),suffix=sum.complete?'':'（取得済み分）';
  write('todaySpent',`${sum.total} WARA相当${suffix}`);write('todayDailySpent',`${sum.daily} Kusa${suffix}`);write('todayWaraSpent',`${sum.credit} WARA${suffix}`);
  write('paymentHistoryNote',`${time.format(new Date(now*1000)).split(' ')[0]} · 日本時間 · 今日${sum.count}件。${sum.complete?'今日の範囲を取得しました。':'今日の全件を取得できていません。「続きを読み込む」で確認してください。'} 支払い履歴${state.entries.length}件を表示。`);
  const rows=$('paymentHistoryRows');rows.replaceChildren();
  for(const entry of state.entries){
   const tr=document.createElement('tr');
   for(const text of [entry.blockTime===null?'時刻不明':time.format(new Date(entry.blockTime*1000)),`${entry.amount} WARA相当`,entry.method==='daily'?'Kusaから':'持っているWARAから']){const td=document.createElement('td');td.textContent=text;tr.append(td);}
   const dest=document.createElement('td');dest.textContent=`${entry.recipient.slice(0,8)}…`;dest.title=entry.recipient;
   const ref=document.createElement('small');ref.textContent=entry.reference?`お会計 ${entry.reference.slice(0,8)}…`:'お会計番号なし';if(entry.reference)ref.title=entry.reference;dest.append(ref);tr.append(dest);
   const cell=document.createElement('td'),link=document.createElement('a');link.href=`https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`;link.target='_blank';link.rel='noopener noreferrer';link.textContent='取引を見る';cell.append(link);tr.append(cell);rows.append(tr);
  }
  if(!state.entries.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='取得した範囲に支払いはありません。';tr.append(td);rows.append(tr);}controls();
 }
 async function update(force=false,more=false){
  const context=getContext();if(!context)return;
  if(busy){if(force&&!more)again=true;return;}
  if(!force&&Date.now()-lastAttempt<60000)return;
  const current=epoch,valid=()=>current===epoch&&getContext()?.generation===context.generation;
  busy=true;lastAttempt=Date.now();controls();write('paymentHistoryNote','チェーンの支払い履歴を読み込んでいます…');
  try{
   await assertDevnet(connection);const now=Number(await readClock(connection));if(!valid())return;
   const next=more&&reader?reader:paymentHistoryReader(connection,context,cache);
   for(let i=0;i<(more?1:5);i++){const state=await next.load();if(!valid())return;if(state.done||more||paymentSummary(state,now).complete)break;}
   reader=next;render(now);
  }catch(e){if(valid())write('paymentHistoryNote',`履歴の更新を完了できませんでした。${e.message||e} 表示済みの合計は更新前の値です。もう一度更新してください。`);}
  finally{if(valid()){busy=false;controls();if(again){again=false;update(true);}}}
 }
 $('refreshPayments').onclick=()=>update(true);$('morePayments').onclick=()=>update(true,true);
 return {reset,update,controls};
}
