import {PublicKey} from '@solana/web3.js';
export const REQUEST_SCHEMA='wara-devnet/request/2', REQUEST_TTL=600_000;
export const MAX_QR_BYTES=2000;
const key=x=>{if(typeof x!=='string'||x.length>44)throw Error('QRのアドレスが不正です。');const k=new PublicKey(x);if(k.toBase58()!==x)throw Error('QRのアドレスが不正です。');return k;};
const reject=()=>{throw Error('このアプリのお会計QRではありません。');};
export function parseRequest(raw,context,now=Date.now()){
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>1000)reject();
 let r;try{r=JSON.parse(raw);}catch{reject();}
 if(!r||![REQUEST_SCHEMA,'wara-devnet/request/1'].includes(r.schema)||r.cluster!=='devnet')reject();
 if(r.program!==String(context.program)||r.config!==String(context.config)||r.mint!==String(context.mint))throw Error('QRと循環設定が違います。二人とも同じ「一日」または「120秒」を選んでください。');
 for(const s of [r.program,r.config,r.mint])key(s);
 if(!PublicKey.isOnCurve(key(r.recipient).toBytes()))throw Error('受取先はウォレットのアドレスを指定してください。');
 if(typeof r.amount!=='string'||!/^[1-9]\d{0,19}$/.test(r.amount)||BigInt(r.amount)>18446744073709551615n)throw Error('お会計QRの金額が不正です。');
 if(typeof r.label!=='string'||r.label.length>40||/[\u0000-\u001f\u007f]/.test(r.label))throw Error('お会計QRの表示名が不正です。');
 if(!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.expiresAt)||r.expiresAt-r.createdAt!==REQUEST_TTL||r.createdAt>now+30_000||now>=r.expiresAt)throw Error('お会計QRの期限が切れているか、端末の時計がずれています。店側で作り直してください。');
 if(r.schema===REQUEST_SCHEMA){key(r.reference);if([r.program,r.config,r.mint,r.recipient].includes(r.reference))throw Error('お会計番号が不正です。');}
 return {...(r.schema===REQUEST_SCHEMA?{reference:r.reference}:{}),schema:r.schema,cluster:'devnet',program:r.program,config:r.config,mint:r.mint,recipient:r.recipient,amount:r.amount,label:r.label,createdAt:r.createdAt,expiresAt:r.expiresAt};
}
export function createRequest(context,recipient,amount,label='',now=Date.now(),reference=new PublicKey(crypto.getRandomValues(new Uint8Array(32))).toBase58()){
 const r={reference:String(reference),schema:REQUEST_SCHEMA,cluster:'devnet',program:String(context.program),config:String(context.config),mint:String(context.mint),recipient:String(recipient),amount:String(amount),label:label.trim(),createdAt:now,expiresAt:now+REQUEST_TTL};
 return JSON.stringify(parseRequest(JSON.stringify(r),context,now));
}
