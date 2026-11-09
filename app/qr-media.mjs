import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {MAX_QR_BYTES} from './qr-protocol.mjs';
export async function qrImage(text){
 if(new TextEncoder().encode(text).length>MAX_QR_BYTES)throw Error('QRに収まらないため、表示名を短くして作り直してください。');
 return QRCode.toDataURL(text,{errorCorrectionLevel:'M',margin:4,scale:6,color:{dark:'#000000',light:'#ffffff'}});
}
export function createScanner({video,canvas,onValue,onStatus,onStop}){
 let stream=null,session=0,timer;
 const context=canvas.getContext('2d',{willReadFrequently:true});
 function stop(){session++;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;onStop();}
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
  try{
   const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false});
   if(id!==session){media.getTracks().forEach(t=>t.stop());return;}
   stream=media;video.srcObject=media;await video.play();
   if(id!==session)return;
   onStatus('QR全体と周囲の白い余白を画面に入れてください。');
   const loop=async()=>{if(id!==session)return;
    try{if(video.readyState>=2&&video.videoWidth){const value=read(video,video.videoWidth,video.videoHeight);if(value){stop();await onValue(value,kind);return;}}}
    catch(e){stop();onStatus(e.message||'読み取りに失敗しました。');return;}
    timer=setTimeout(loop,180);
   };loop();
  }catch(e){if(id!==session)return;stop();throw Error(e.name==='NotAllowedError'?'カメラが許可されていません。「QR画像を選ぶ」でも読み取れます。':`カメラを開始できません。QR画像を選んでください。${e.message||''}`);}
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
