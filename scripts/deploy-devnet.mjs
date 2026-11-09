// Uses only dedicated ignored Devnet keys. No global Solana config is read or changed.
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {connection,payer,key,send,save} from './devnet-common.mjs';
import {initInstructions,readInstance,pk} from '../app/protocol.mjs';
const payerKey=await payer(),programKey=await key('devnet-program');
const binary='target/deploy/straw_protocol.so';await access(binary);
const bytes=await readFile(binary),sha256=createHash('sha256').update(bytes).digest('hex');
const balance=await connection.getBalance(payerKey.publicKey);
console.log(`Devnet payer: ${payerKey.publicKey}\nProgram: ${programKey.publicKey}\nBalance: ${balance/1e9} test SOL`);
const existing=await connection.getAccountInfo(programKey.publicKey);
let receipt;try{receipt=JSON.parse(await readFile('deployments/devnet.json','utf8'));}catch{}
let deploymentSignature=receipt?.deploymentSignature||null;
async function matchesBinary(account){
 const loader=pk('BPFLoaderUpgradeab1e11111111111111111111111');
 if(!account?.executable||!account.owner.equals(loader)||account.data.length!==36||account.data.readUInt32LE(0)!==2)return false;
 const programData=await connection.getAccountInfo(pk(account.data.subarray(4,36)));
 return Boolean(programData&&programData.owner.equals(loader)&&programData.data.readUInt32LE(0)===3&&programData.data[12]===1&&pk(programData.data.subarray(13,45)).equals(payerKey.publicKey)&&programData.data.subarray(45,45+bytes.length).equals(bytes)&&programData.data.subarray(45+bytes.length).every(x=>x===0));
}
const sameBinary=await matchesBinary(existing);
if(!sameBinary){
 const estimate=await connection.getMinimumBalanceForRentExemption(bytes.length*2+45)+100_000_000;
 if(balance<estimate)throw Error(`Devnet deployment requires approximately ${Math.ceil(estimate/1e8)/10} test SOL; fund the dedicated payer via https://faucet.solana.com/ and rerun. No real SOL is needed.`);
 let cli=process.env.SOLANA_CLI||'solana';if(!process.env.SOLANA_CLI){try{await access('private/toolchain/solana-release/bin/solana');cli='private/toolchain/solana-release/bin/solana';}catch{}}
 await key('devnet-buffer');
 await writeFile('private/solana-cli.yml','json_rpc_url: https://api.devnet.solana.com\nwebsocket_url: wss://api.devnet.solana.com/\nkeypair_path: private/devnet-payer.json\ncommitment: confirmed\n',{mode:0o600});
 const result=spawnSync(cli,['program','deploy',binary,'--config','private/solana-cli.yml','--buffer','private/devnet-buffer.json','--url','https://api.devnet.solana.com','--keypair','private/devnet-payer.json','--program-id','private/devnet-program.json','--upgrade-authority','private/devnet-payer.json','--output','json'],{encoding:'utf8'});
 if(result.status!==0){throw Error(result.error?.message||result.stderr||'Program deploy failed');}console.log(result.stdout);deploymentSignature=JSON.parse(result.stdout).signature;
}
const deployed=await connection.getAccountInfo(programKey.publicKey);if(!await matchesBinary(deployed))throw Error('Deployed bytecode or upgrade authority does not match');
const instances={};
for(const [name,period] of [['daily',86400],['demo',120]]){
 const cfg=await key(`devnet-config-${name}`);let signature=null;
 if(!await connection.getAccountInfo(cfg.publicKey))signature=await send(initInstructions(programKey.publicKey,cfg.publicKey,payerKey.publicKey,period,await connection.getMinimumBalanceForRentExemption(81)),[payerKey,cfg]);
 const data=await readInstance(connection,programKey.publicKey,cfg.publicKey);
 if(data.period!==BigInt(period))throw Error('Unexpected existing instance period');
 instances[name]={config:String(cfg.publicKey),mint:String(data.mint),periodSeconds:period,offsetSeconds:Number(data.offset),initializationSignature:signature||receipt?.instances?.[name]?.initializationSignature||null};
}
await mkdir('deployments',{recursive:true});await save('deployments/devnet.json',{cluster:'devnet',rpc:'https://api.devnet.solana.com',program:String(programKey.publicKey),instances,status:'deployed',deploymentSignature,binarySha256:sha256,upgradeAuthority:String(payerKey.publicKey),updatedAt:new Date().toISOString()});
console.log('Public deployment manifest saved. npm run build && npm start → /devnet/');
