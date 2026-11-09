import QRCode from 'qrcode';
import jsQR from 'jsqr';
export function roundtrip(text,scale=4){
 const {modules}=QRCode.create(text,{errorCorrectionLevel:'M'}),size=(modules.size+8)*scale;
 const pixels=new Uint8ClampedArray(size*size*4).fill(255);
 for(let y=0;y<modules.size;y++)for(let x=0;x<modules.size;x++)if(modules.get(y,x))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
  const i=(((y+4)*scale+dy)*size+(x+4)*scale+dx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;
 }
 return jsQR(pixels,size,size)?.data;
}
