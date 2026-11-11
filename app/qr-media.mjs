import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {MAX_QR_BYTES} from './qr-protocol.mjs';
export async function qrImage(text){
 if(new TextEncoder().encode(text).length>MAX_QR_BYTES)throw Error('QRに収まらないため、表示名を短くして作り直してください。');
 return QRCode.toDataURL(text,{errorCorrectionLevel:'M',margin:4,scale:6,color:{dark:'#000000',light:'#ffffff'}});
}
export function createScanner({video,canvas,onValue,onStatus,onStop}){
 let stream=null,session=0,timer,playing;
 const context=canvas.getContext('2d',{willReadFrequently:true});
 function stop(){session++;clearTimeout(timer);if(playing)video.removeEventListener('playing',playing);playing=null;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;video.controls=false;onStop();}
 function read(source,width,height){
  const scale=Math.min(1,1600/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  context.drawImage(source,0,0,canvas.width,canvas.height);
  const frame=context.getImageData(0,0,canvas.width,canvas.height);
  return jsQR(frame.data,frame.width,frame.height,{inversionAttempts:'attemptBoth'})?.data;
 }
 async function start(kind){
  stop();const id=session;
  if(!navigator.mediaDevices?.getUserMedia)throw Error('このブラウザではカメラを使えません。「QR画像を選ぶ」を使ってください。');
  onStatus('カメラの許可を確認しています…');
  let media;
  try{
   try{media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false});}
   catch(e){
    if(id!==session)return;
    if(!['OverconstrainedError','ConstraintNotSatisfiedError'].includes(e.name))throw e;
    media=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
   }
  }catch(e){
   if(id!==session)return;stop();
   throw Error(['NotAllowedError','PermissionDeniedError'].includes(e.name)
    ?'カメラへのアクセスが許可されていません。ブラウザのアドレスバー（URL左のアイコンや「ぁあ」）からカメラを「許可」にして再試行してください。「QR画像を選ぶ」でも読み取れます。'
    :`カメラを開始できません。「QR画像を選ぶ」を使ってください。${e.message||''}`);
  }
  if(id!==session){media.getTracks().forEach(t=>t.stop());return;}
  stream=media;
  try{
   video.muted=true;video.playsInline=true;video.autoplay=true;
   video.setAttribute('muted','');video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
   video.srcObject=media;
   const guide='QR全体と周囲の白い余白を画面に入れてください。';
   playing=()=>{if(id===session){video.controls=false;onStatus(guide);}};
   video.addEventListener('playing',playing);
   onStatus(guide);
   // Do not gate the scan loop on play(): it may reject or remain pending until frames arrive.
   const play=async()=>{
    try{await video.play();}
    catch(e){
     if(id!==session)return;
     console.warn('QR camera preview playback failed:',e);
     video.controls=true;
     onStatus('カメラは接続されています。映像が動かない場合は動画の再生ボタンを押してください。「QR画像を選ぶ」でも読み取れます。');
    }
   };void play();
   const loop=async()=>{if(id!==session)return;
    try{if(video.readyState>=2&&video.videoWidth){const value=read(video,video.videoWidth,video.videoHeight);if(value){stop();await onValue(value,kind);return;}}}
    catch(e){stop();onStatus(e.message||'読み取りに失敗しました。');return;}
    timer=setTimeout(loop,180);
   };loop();
  }catch(e){if(id!==session)return;stop();throw Error(`カメラ映像を表示できません。「QR画像を選ぶ」を使ってください。${e.message||''}`);}
 }
 async function file(file,kind){
  stop();const id=session;if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('10MB以下のPNG・JPEG・WebPのQR画像を選んでください。');
  const url=URL.createObjectURL(file),img=new Image();
  try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('画像を開けません。'));img.src=url;});
   if(id!==session)return;
   const value=read(img,img.naturalWidth,img.naturalHeight);if(!value)throw Error('QRが見つかりません。余白を含む、鮮明なQR画像を選んでください。');
   await onValue(value,kind);
  }finally{URL.revokeObjectURL(url);}
 }
 return {start,stop,file};
}
