(function(){
  const el={video:document.getElementById('video'),view:document.getElementById('view'),overlay:document.getElementById('overlay'),
    startBtn:document.getElementById('startBtn'),stopBtn:document.getElementById('stopBtn'),snapBtn:document.getElementById('snapBtn'),
    thr:document.getElementById('thr'),thrVal:document.getElementById('thrVal'),sens:document.getElementById('sens'),sensVal:document.getElementById('sensVal'),
    stability:document.getElementById('stability'),stabVal:document.getElementById('stabVal'),profile:document.getElementById('profile'),
    overlayMode:document.getElementById('overlayMode'),status:document.getElementById('status'),fps:document.getElementById('fps'),
    msg:document.getElementById('msg'),clearSW:document.getElementById('clearSW'),installBtn:document.getElementById('installBtn'),helpBtn:document.getElementById('helpBtn'),
    tapHint:document.getElementById('tapHint'),tapStart:document.getElementById('tapStart')};
  const setMsg=s=>{el.msg.textContent=s;console.log('[ttd]',s)};
  const bindRange=(r,lab,fmt=v=>Number(v/100).toFixed(2))=>{const f=()=>lab.textContent=fmt(r.value);r.addEventListener('input',f);f()}
  bindRange(el.thr,el.thrVal);bindRange(el.sens,el.sensVal);bindRange(el.stability,el.stabVal,v=>String(v));

  let stream=null,anim=null,W=640,H=480,lastTime=0,frames=0;

  // Profiles (Balanced default for phones)
  const BASE={vMaxBase:0.58,vMin:0.08,sMinBase:0.58,hTolBase:14,aMinBase:38,bMaxBase:20,aDivBRatio:2.0,crRelBase:95,yMaxBase:182,
    minArea:140,maxFrac:0.14,edgeMagThresh:65,maxEdgeDensity:0.22,maxSpecDensity:0.02,minSolidity:0.80,maxOriDominance:0.50};
  const PROFILES={safety:{...BASE,vMaxBase:0.55,sMinBase:0.60,hTolBase:12,aMinBase:40,bMaxBase:18,aDivBRatio:2.1,crRelBase:100,yMaxBase:175,minArea:160,maxFrac:0.12,edgeMagThresh:70,maxEdgeDensity:0.20,maxSpecDensity:0.015,minSolidity:0.82,maxOriDominance:0.48},
    balanced:{...BASE},
    aggressive:{...BASE,vMaxBase:0.66,sMinBase:0.52,aMinBase:34,bMaxBase:24,crRelBase:88,yMaxBase:190,minArea:110,maxFrac:0.18,edgeMagThresh:58,maxEdgeDensity:0.26,maxSpecDensity:0.03,minSolidity:0.78,maxOriDominance:0.56}};
  const getTune=()=>PROFILES[el.profile.value];

  function toHSV(r,g,b){const rn=r/255,gn=g/255,bn=b/255;const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;if(d!==0){if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));else if(max===gn)h=((bn-rn)/d+2);else h=((rn-gn)/d+4);h/=6}const s=max===0?0:d/max,v=max;return {h,s,v}}
  function toYCbCr(r,g,b){const y=0.299*r+0.587*g+0.114*b;const cb=128-0.168736*r-0.331264*g+0.5*b;const cr=128+0.5*r-0.418688*g-0.081312*b;return {y,cb,cr}}
  function srgb2lin(c){c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
  function toLab(r,g,b){const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);const X=0.4124564*R+0.3575761*G+0.1804375*B;const Y=0.2126729*R+0.7151522*G+0.0721750*B;const Z=0.0193339*R+0.1191920*G+0.9503041*B;const Xn=0.95047,Yn=1.0,Zn=1.08883;const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)}}
  const hueDistDeg=(hDeg,ref)=>{let d=Math.abs(hDeg-ref)%360;if(d>180)d=360-d;return d}

  function scorePixel(r,g,b,sens,tune){
    if(!(r>g&&g>=b))return 0;
    const {h,s,v}=toHSV(r,g,b);const hDeg=h*360,hTol=tune.hTolBase+10*(1-sens);const sMin=tune.sMinBase-0.25*(1-sens);const vMax=tune.vMaxBase+0.10*(1-sens);
    if(hueDistDeg(hDeg,0)>hTol||s<sMin||v<tune.vMin||v>vMax)return 0;
    const r_g=r/Math.max(1,g),r_b=r/Math.max(1,b);if(r_g<(1.28-0.1*sens)||r_b<(1.9-0.3*sens)||(r-g)<12||(r-b)<26)return 0;
    const {y,cb,cr}=toYCbCr(r,g,b);const crRel=cr-0.55*cb;if(y>tune.yMaxBase+25*(1-sens)||crRel<tune.crRelBase-20*(1-sens))return 0;
    const {L,a,b:bb}=toLab(r,g,b);const aMin=tune.aMinBase-8*(1-sens);const bMax=tune.bMaxBase+8*(1-sens);if(a<aMin||bb>bMax||(a/Math.max(1e-3,bb))<tune.aDivBRatio||L>64)return 0;
    const hueScore=Math.max(0,1-hueDistDeg(hDeg,0)/(hTol+1));const satScore=Math.min(1,(s-0.35)/0.5);const valScore=Math.min(1,(0.74-v)/0.4);
    const crCbScore=Math.min(1,(crRel-80)/85);const labScore=Math.min(1,((a-aMin)/30+(Math.max(0,bMax-bb)/20))/2);const ratioScore=Math.min(1,((r_b-1.55)/1.5+(r_g-1.12)/0.7)/2);
    let sc=0.27*hueScore+0.16*satScore+0.17*valScore+0.20*crCbScore+0.16*labScore+0.04*ratioScore;return Math.max(0,Math.min(1,sc))
  }

  function computeGray(img){const d=img.data,g=new Float32Array(img.width*img.height);for(let p=0,i=0;p<d.length;p+=4,i++)g[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];return g}
  function sobel(gray,w,h){const mag=new Float32Array(w*h),ori=new Float32Array(w*h);const get=(x,y)=>gray[Math.max(0,Math.min(h-1,y))*w+Math.max(0,Math.min(w-1,x))];
    for(let y=0;y<h;y++){for(let x=0;x<w;x++){const gx=-get(x-1,y-1)-2*get(x-1,y)-get(x-1,y+1)+get(x+1,y-1)+2*get(x+1,y)+get(x+1,y+1);
      const gy=-get(x-1,y-1)-2*get(x,y-1)-get(x+1,y-1)+get(x-1,y+1)+2*get(x,y+1)+get(x+1,y+1);mag[y*w+x]=Math.hypot(gx,gy);ori[y*w+x]=Math.atan2(gy,gx);}}
    return {mag,ori}}

  function filterBlobs(binary,w,h,img,tune){
    const visited=new Uint8Array(w*h),keep=new Uint8Array(w*h),px=img.data,gray=computeGray(img);const {mag,ori}=sobel(gray,w,h);
    const minArea=tune.minArea,maxArea=Math.floor(w*h*tune.maxFrac);const isSpecular=(r,g,b)=>{const {h,s,v}=toHSV(r,g,b);return(v>0.85&&s<0.25)};
    function flood(start){
      const q=[start];visited[start]=1;const coords=[];let area=0,perim=0,sumV=0,edgeCount=0,specCount=0;const oriBins=new Float32Array(18);
      let minx=w,maxx=0,miny=h,maxy=0;
      while(q.length){const cur=q.pop();coords.push(cur);area++;const x=cur%w,y=(cur-x)/w; if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y;
        const p=cur*4,r=px[p],g=px[p+1],b=px[p+2];const v=Math.max(r,g,b)/255;sumV+=v;if(isSpecular(r,g,b))specCount++; if(mag[cur]>tune.edgeMagThresh)edgeCount++;
        let ang=ori[cur];if(ang<0)ang+=Math.PI*2;const bin=Math.min(17,Math.floor(ang/(Math.PI*2)*18));oriBins[bin]++;
        const neigh=[cur-1,cur+1,cur-w,cur+w];let boundary=false;for(const n of neigh){if(n<0||n>=w*h){boundary=true;continue}if(!binary[n])boundary=true;if(!visited[n]&&binary[n]){visited[n]=1;q.push(n)}} if(boundary)perim++;}
      const bboxArea=(maxx-minx+1)*(maxy-miny+1);const solidity=area/Math.max(1,bboxArea);const meanV=sumV/Math.max(1,area);const edgeDensity=edgeCount/Math.max(1,area);
      const specDensity=specCount/Math.max(1,area);let maxBin=0,sumBins=0;for(let i=0;i<18;i++){if(oriBins[i]>maxBin)maxBin=oriBins[i];sumBins+=oriBins[i]} const oriDominance=maxBin/Math.max(1,sumBins);
      const ok=(area>=minArea)&&(area<=maxArea)&&(meanV<=tune.vMaxBase+0.02)&&(solidity>=tune.minSolidity)&&(edgeDensity<=tune.maxEdgeDensity)&&(specDensity<=tune.maxSpecDensity)&&(oriDominance<=tune.maxOriDominance);
      return {ok,coords}}
    for(let i=0;i<w*h;i++){if(visited[i]||!binary[i])continue;const {ok,coords}=flood(i); if(ok)for(const id of coords)keep[id]=1}
    return keep
  }

  let persist=null,stableMask=null;

  async function start(){
    if(stream)return;
    try{
      el.status.textContent='Requesting camera…';
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false})
    }catch(e){setMsg('Camera error: '+e.message);return}
    el.video.srcObject=stream;try{await el.video.play()}catch{}
    W=el.video.videoWidth||640;H=el.video.videoHeight||480;for(const c of [el.view,el.overlay]){c.width=W;c.height=H}
    el.startBtn.disabled=true;el.stopBtn.disabled=false;el.snapBtn.disabled=false;el.tapHint.style.display='none';setMsg('Streaming…')

    const ctx=el.view.getContext('2d',{willReadFrequently:true});const ox=el.overlay.getContext('2d');

    function frame(ts){
      if(!stream){cancelAnimationFrame(anim);return}
      frames++;if(ts-lastTime>1000){el.fps.textContent=frames+' fps';frames=0;lastTime=ts}

      // Draw original color frame
      ctx.drawImage(el.video,0,0,W,H);
      const colorFrame = ctx.getImageData(0,0,W,H); // keep COLOR for detection

      // Build a grayscale for background view only (do NOT use for detection)
      const grayFrame = new ImageData(new Uint8ClampedArray(colorFrame.data), W, H);
      for(let p=0;p<grayFrame.data.length;p+=4){
        const r=grayFrame.data[p],g=grayFrame.data[p+1],b=grayFrame.data[p+2];
        const y=(r*0.2126+g*0.7152+b*0.0722)|0;
        grayFrame.data[p]=grayFrame.data[p+1]=grayFrame.data[p+2]=y;
      }
      ctx.putImageData(grayFrame,0,0);

      const d=colorFrame.data,sens=Number(el.sens.value)/100,thr=Number(el.thr.value)/100,tune=getTune();
      const score=new Float32Array(W*H);let min=1e9,max=-1e9;
      for(let p=0,i=0;p<d.length;p+=4,i++){const s=scorePixel(d[p],d[p+1],d[p+2],sens,tune);score[i]=s;if(s<min)min=s;if(s>max)max=s}
      const rng=Math.max(1e-6,max-min);const bin=new Uint8Array(W*H);for(let i=0;i<score.length;i++){const n=(score[i]-min)/rng;if(n>=thr)bin[i]=1}
      const kept=filterBlobs(bin,W,H,colorFrame,tune);

      if(!persist){persist=new Uint8Array(W*H);stableMask=new Uint8Array(W*H)}const need=Number(el.stability.value);
      for(let i=0;i<kept.length;i++){if(kept[i])persist[i]=Math.min(255,persist[i]+1);else persist[i]=Math.max(0,persist[i]-1);stableMask[i]=persist[i]>=need?1:0}

      ox.clearRect(0,0,W,H);const mode=el.overlayMode.value;
      if(mode==='debug'){const heat=ox.createImageData(W,H);const dd=heat.data;for(let i=0,p=0;i<score.length;i++,p+=4){const n=(score[i]-min)/rng;dd[p]=Math.min(255,n*255);dd[p+1]=0;dd[p+2]=Math.min(255,(1-n)*255);dd[p+3]=255}ox.putImageData(heat,0,0)}
      else{const out=ox.createImageData(W,H);const od=out.data;for(let i=0,p=0;i<stableMask.length;i++,p+=4){if(stableMask[i]){od[p]=235;od[p+1]=20;od[p+2]=20;od[p+3]=200}else od[p+3]=0}
        if(mode==='mask'){ox.putImageData(out,0,0)}else if(mode==='blend'){ox.putImageData(out,0,0);el.overlay.style.mixBlendMode='screen'}
        else if(mode==='contour'){ox.putImageData(out,0,0);const imgData=ox.getImageData(0,0,W,H);const px=imgData.data;ox.clearRect(0,0,W,H);ox.lineWidth=2;ox.strokeStyle='rgba(239,68,68,.95)';ox.beginPath();
          for(let y=1;y<H-1;y+=2){for(let x=1;x<W-1;x+=2){const i=(y*W+x)*4;if(px[i+3]>0&&(px[i-4+3]===0||px[i+4+3]===0||px[i-4*W+3]===0||px[i+4*W+3]===0)){ox.moveTo(x,y);ox.lineTo(x+0.01,y+0.01)}}}ox.stroke()}}

      anim=requestAnimationFrame(frame)
    }
    anim=requestAnimationFrame(frame)
  }

  function stop(){if(anim)cancelAnimationFrame(anim);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}el.startBtn.disabled=false;el.stopBtn.disabled=true;el.snapBtn.disabled=true;el.tapHint.style.display='';setMsg('Stopped.')}
  function snapshot(){const a=document.createElement('a');a.download=`trackthedrop_${Date.now()}.png`;a.href=el.view.toDataURL('image/png');a.click()}

  if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{})}
  el.clearSW.onclick=async()=>{if('caches'in window){const names=await caches.keys();await Promise.all(names.map(n=>caches.delete(n)));location.reload()}}
  let deferredPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;el.installBtn.style.display='inline-flex'});
  el.installBtn.onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();deferredPrompt=null}}
  el.helpBtn.onclick=()=>alert('Not thermal. Debug=score. On mobile, Balanced is a good start. If nothing shows, lower Threshold to 0.45–0.55 or change Profile to Aggressive. Stability 2–3 frames.');

  el.tapStart.addEventListener('click',()=>{if(!stream)start()});
  el.startBtn.addEventListener('click',start);el.stopBtn.addEventListener('click',stop);el.snapBtn.addEventListener('click',snapshot);
  setMsg('JS loaded. Ready.');
})();