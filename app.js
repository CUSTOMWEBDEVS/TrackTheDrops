// v7.7 hardened
(function(){
  const $=id=>document.getElementById(id);
  const el={video:$('video'),overlay:$('overlay'),tapHint:$('tapHint'),status:$('status'),fps:$('fps'),
    startBtn:$('startBtn'),torchBtn:$('torchBtn'),alertBtn:$('alertBtn'),
    flash:$('flash'),installBtn:$('installBtn'),
    viewport:$('viewport'), app:$('app') };
  const octx = $('overlay').getContext('2d');

  window.onerror = (msg, src, line, col, err)=>{ el.status.textContent = 'ERR: '+(err && err.message ? err.message : msg); };
  window.onunhandledrejection = (e)=>{ el.status.textContent = 'PromiseERR: '+ (e.reason && e.reason.message ? e.reason : 'rejection'); };

  let uiTimer=null;
  function showUI(){ el.app.classList.remove('hiddenUI'); if(uiTimer) clearTimeout(uiTimer); uiTimer=setTimeout(()=>el.app.classList.add('hiddenUI'),2200) }
  ;['startBtn','torchBtn','alertBtn','installBtn'].forEach(id=>{
    const b=el[id]; if(!b) return;
    b.addEventListener('click', (e)=>{ e.stopPropagation(); showUI(); }, true);
  });
  el.viewport.addEventListener('click',()=>{
    const hintVisible = el.tapHint.style.display !== 'none';
    if(!stream && hintVisible){ start(); return; }
    showUI();
  });

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const hasCap = (typeof window!=='undefined' && window.Capacitor && window.Capacitor.Haptics);
  let aCtx; try{ aCtx=new (window.AudioContext||window.webkitAudioContext)() }catch{}
  async function hapticPulse(){
    if(el.alertBtn.getAttribute('aria-pressed')!=='true') return;
    if(hasCap){ try{ await window.Capacitor.Haptics.impact({ style:'medium' }); return; }catch{} }
    if('vibrate' in navigator && !isIOS){ navigator.vibrate(40); return; }
    try{ if(aCtx && aCtx.state==='suspended') await aCtx.resume(); if(aCtx){ const o=aCtx.createOscillator(), g=aCtx.createGain(); o.type='square'; o.frequency.value=1100; g.gain.value=0.05; o.connect(g); g.connect(aCtx.destination); o.start(); setTimeout(()=>o.stop(),60);} }catch{}
    flashOnce();
  }
  function flashOnce(){ el.flash.style.opacity='0.45'; setTimeout(()=>el.flash.style.opacity='0',120) }

  let stream=null, anim=null, lastTS=0, frames=0;
  let dispW=640, dispH=480, procW=320, procH=240, frameCount=0;
  let persist=null, stableMask=null, edgesCache=null;
  const proc=document.createElement('canvas'), procCtx=proc.getContext('2d',{willReadFrequently:true});

  function setViewportSize(){
    dispW=el.video.videoWidth||el.viewport.clientWidth; dispH=el.video.videoHeight||el.viewport.clientHeight;
    el.overlay.width=Math.max(1,dispW); el.overlay.height=Math.max(1,dispH);
  }
  window.addEventListener('resize',()=>{ if(stream) setViewportSize() });

  const BASE={vMaxBase:0.66,vMin:0.08,sMinBase:0.52,hTolBase:14,aMinBase:34,bMaxBase:24,aDivBRatio:2.0,crRelBase:88,yMaxBase:190,
    minAreaFrac:0.0007,maxFrac:0.18,edgeMagThresh:58,maxEdgeDensity:0.26,maxSpecDensity:0.03,minSolidity:0.78,maxOriDominance:0.56};
  const tune={...BASE};

  function toHSV(r,g,b){const rn=r/255,gn=g/255,bn=b/255;const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;if(d!==0){if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));else if(max===gn)h=((bn-rn)/d+2);else h=((rn-gn)/d+4);h/=6}const s=max===0?0:d/max,v=max;return {h,s,v}}
  function toYCbCr(r,g,b){const y=0.299*r+0.587*g+0.114*b;const cb=128-0.168736*r-0.331264*g+0.5*b;const cr=128+0.5*r-0.418688*g-0.081312*b;return {y,cb,cr}}
  function srgb2lin(c){c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
  function toLab(r,g,b){const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);const X=0.4124564*R+0.3575761*G+0.1804375*B;const Y=0.2126729*R+0.7151522*G+0.0721750*B;const Z=0.0193339*R+0.1191920*G+0.9503041*B;const Xn=0.95047,Yn=1.0,Zn=1.08883;const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)}}
  const hueDistDeg=(hDeg,ref)=>{let d=Math.abs(hDeg-ref)%360;if(d>180)d=360-d;return d}

  function scorePixel(r,g,b,sens,t,doLab){
    if(!(r>g&&g>=b))return 0;
    const {h,s,v}=toHSV(r,g,b);const hDeg=h*360,hTol=t.hTolBase+10*(1-sens);const sMin=t.sMinBase-0.25*(1-sens);const vMax=t.vMaxBase+0.10*(1-sens);
    if(hueDistDeg(hDeg,0)>hTol||s<sMin||v<t.vMin||v>vMax)return 0;
    const r_g=r/Math.max(1,g),r_b=r/Math.max(1,b);if(r_g<(1.28-0.1*sens)||r_b<(1.9-0.3*sens)||(r-g)<12||(r-b)<26)return 0;
    const {y,cb,cr}=toYCbCr(r,g,b);const crRel=cr-0.55*cb;if(y>t.yMaxBase+25*(1-sens)||crRel<t.crRelBase-20*(1-sens))return 0;
    if(doLab){const {L,a,b:bb}=toLab(r,g,b);const aMin=t.aMinBase-8*(1-sens);const bMax=t.bMaxBase+8*(1-sens);
      if(a<aMin||bb>bMax||(a/Math.max(1e-3,bb))<t.aDivBRatio||L>64)return 0;}
    const hueScore=Math.max(0,1-hueDistDeg(hDeg,0)/(hTol+1));const satScore=Math.min(1,(s-0.35)/0.5);const valScore=Math.min(1,(0.74-v)/0.4);
    const crCbScore=Math.min(1,(crRel-80)/85);const ratioScore=Math.min(1,((r_b-1.55)/1.5+(r_g-1.12)/0.7)/2);
    let sc=0.30*hueScore+0.16*satScore+0.17*valScore+0.22*crCbScore+0.11*0.9+0.04*ratioScore;return Math.max(0,Math.min(1,sc))
  }

  function sobel(gray,w,h){
    const mag=new Float32Array(w*h),ori=new Float32Array(w*h);
    const get=(x,y)=>gray[Math.max(0,Math.min(h-1,y))*w+Math.max(0,Math.min(w-1,x))];
    for(let y=0;y<h;y++){for(let x=0;x<w;x++){
      const gx=-get(x-1,y-1)-2*get(x-1,y)-get(x-1,y+1)+get(x+1,y-1)+2*get(x+1,y)+get(x+1,y+1);
      const gy=-get(x-1,y-1)-2*get(x,y-1)-get(x+1,y-1)+get(x-1,y+1)+2*get(x,y+1)+get(x+1,y+1);
      mag[y*w+x]=Math.hypot(gx,gy);ori[y*w+x]=Math.atan2(gy,gx);
    }} return {mag,ori}
  }

  function filterBlobs(binary,w,h,t,edges){
    const visited=new Uint8Array(w*h),keep=new Uint8Array(w*h),ori=edges.ori;
    const minArea=Math.max(6,Math.floor(w*h*t.minAreaFrac)),maxArea=Math.floor(w*h*t.maxFrac);
    function flood(start){
      const q=[start];visited[start]=1;const coords=[];let area=0;const oriBins=new Float32Array(12);
      let minx=w,maxx=0,miny=h,maxy=0,cx=0,cy=0;
      while(q.length){const cur=q.pop();coords.push(cur);area++;const x=cur%w,y=(cur-x)/w;cx+=x;cy+=y;
        if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;
        let ang=ori[cur];if(ang<0)ang+=Math.PI*2;const bin=Math.min(11,Math.floor(ang/(Math.PI*2)*12));oriBins[bin]++;
        const neigh=[cur-1,cur+1,cur-w,cur+w];
        for(const n of neigh){if(n<0||n>=w*h)continue;if(!visited[n]&&binary[n]){visited[n]=1;q.push(n)}}
      }
      const bboxArea=(maxx-minx+1)*(maxy-miny+1);const solidity=area/Math.max(1,bboxArea);
      let maxBin=0,sumBins=0;for(let i=0;i<12;i++){if(oriBins[i]>maxBin)maxBin=oriBins[i];sumBins+=oriBins[i]}const oriDominance=maxBin/Math.max(1,sumBins);
      const ok=(area>=minArea)&&(area<=maxArea)&&(solidity>=t.minSolidity)&&(oriDominance<=t.maxOriDominance);
      const centroid={x:cx/Math.max(1,area),y:cy/Math.max(1,area)};
      return {ok,coords,centroid,area}
    }
    const blobs=[];
    for(let i=0;i<w*h;i++){if(visited[i]||!binary[i])continue;const res=flood(i);if(res.ok){for(const id of res.coords)keep[id]=1;blobs.push(res)}}
    return {keep,blobs}
  }

  function sizeProcessingCanvas(){
    setViewportSize();
    const scale=320/Math.max(1,dispW); const w=Math.max(160,Math.round(dispW*scale)); const h=Math.max(120,Math.round(dispH*scale));
    proc.width=w; proc.height=h; procW=w; procH=h;
  }

  let starting=false;
  async function start(){
    if(stream||starting) return; starting=true;
    try{
      el.status.textContent='Requesting camera…';
      const tries=[
        {video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}},
        {video:{facingMode:{ideal:'environment'}}},
        {video:true},
        {video:{facingMode:'user'}}
      ];
      let s=null, lastErr='';
      for(const c of tries){
        try{
          const req = Object.assign({audio:false}, c);
          s = await navigator.mediaDevices.getUserMedia(req);
          if(s) break;
        }catch(e){ lastErr=e && e.name ? e.name : 'err'; }
      }
      if(!s){ el.status.textContent='Camera failed: '+lastErr; starting=false; return; }
      stream=s; el.video.srcObject=stream;
      await new Promise(res=>{
        const done=()=>{ el.video.removeEventListener('loadedmetadata',done); res(); };
        el.video.addEventListener('loadedmetadata',done); setTimeout(done,300);
      });
      try{ await el.video.play() }catch{}
      sizeProcessingCanvas(); el.tapHint.style.display='none'; el.status.textContent='Streaming…';
      el.startBtn.textContent='Stop';
      frames=0; lastTS=performance.now(); frameCount=0; persist=null; stableMask=null; edgesCache=null;
      showUI(); loop();
    }catch(e){ el.status.textContent='Camera error'; } finally{ starting=false; }
  }
  function stop(){
    if(anim) cancelAnimationFrame(anim); anim=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null }
    el.tapHint.style.display=''; el.status.textContent='Stopped.'; el.startBtn.textContent='Start'; showUI();
  }
  el.startBtn.addEventListener('click',(e)=>{ e.stopPropagation(); stream?stop():start() }, true);

  async function toggleTorch(e){
    e.stopPropagation();
    try{
      if(stream){
        const track=stream.getVideoTracks()[0];
        const caps = track.getCapabilities ? track.getCapabilities() : null;
        if(caps && ('torch' in caps)){
          const cons = track.getConstraints ? track.getConstraints() : {};
          let curTorch=false;
          if(cons && cons.advanced && cons.advanced.length){
            curTorch = !!cons.advanced.find(o=>o && o.torch === true);
          }
          const next = !curTorch;
          await track.applyConstraints({advanced:[{torch:next}]});
          el.torchBtn.textContent=next?'Flash (on)':'Flashlight';
          return;
        }
      }
    }catch(err){ /* ignore */ }
    el.flash.style.opacity=(el.flash.style.opacity==='1'?'0':'1');
  }
  el.torchBtn.addEventListener('click', toggleTorch, true);

  el.alertBtn.addEventListener('click',(e)=>{
    e.stopPropagation();
    const on = el.alertBtn.getAttribute('aria-pressed')!=='true';
    el.alertBtn.setAttribute('aria-pressed', String(on));
    el.alertBtn.textContent = on ? 'Alert: On' : 'Alert: Off';
    showUI();
  }, true);

  function loop(ts){
    try{
      if(!stream){ cancelAnimationFrame(anim); return }
      if(!proc.width||!proc.height) sizeProcessingCanvas();
      frames++; if(ts-lastTS>1000){ el.fps.textContent=frames+' fps'; frames=0; lastTS=ts }
      frameCount++;

      procCtx.drawImage(el.video,0,0,procW,procH);
      const img=procCtx.getImageData(0,0,procW,procH);
      const d=img.data, sens=1.0, thr=0.15;
      const doLab=(frameCount%2===0);

      const score=new Float32Array(procW*procH); let max=-1e9, min=1e9;
      for(let p=0,i=0;p<d.length;p+=4,i++){const s=scorePixel(d[p],d[p+1],d[p+2],sens,tune,doLab); score[i]=s; if(s>max)max=s; if(s<min)min=s;}
      const rng=Math.max(1e-6,max-min);
      const bin=new Uint8Array(procW*procH); for(let i=0;i<score.length;i++){const n=(score[i]-min)/rng; if(n>=thr) bin[i]=1;}

      if(frameCount%3===1 || !edgesCache){
        const gray=new Float32Array(procW*procH);
        for(let p=0,i=0;p<d.length;p+=4,i++){gray[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2]}
        edgesCache=sobel(gray,procW,procH);
      }

      if(!persist){persist=new Uint8Array(procW*procH);stableMask=new Uint8Array(procW*procH)}
      for(let i=0;i<bin.length;i++){ if(bin[i]) persist[i]=Math.min(255,persist[i]+1); else persist[i]=Math.max(0,persist[i]-1); stableMask[i]=(persist[i]>=1)?1:0; }

      const {blobs}=filterBlobs(bin,procW,procH,tune,edgesCache);

      octx.clearRect(0,0,el.overlay.width,el.overlay.height);
      const out=procCtx.createImageData(procW,procH), od=out.data, alpha=0.87;
      for(let i=0,p=0;i<stableMask.length;i++,p+=4){ if(stableMask[i]){ od[p]=235;od[p+1]=20;od[p+2]=20;od[p+3]=Math.floor(alpha*255);} }
      procCtx.putImageData(out,0,0); octx.drawImage(proc,0,0,el.overlay.width,el.overlay.height);

      let anyHit=false;
      for(const b of blobs){
        let stableCnt=0; for(const idx of b.coords){ if(stableMask[idx]) stableCnt++ }
        if(stableCnt>12){
          const cx=b.centroid.x*el.overlay.width/procW, cy=b.centroid.y*el.overlay.height/procH;
          octx.save();
          octx.strokeStyle='rgba(180,0,255,1)'; // bright purple
          octx.shadowBlur=8; octx.shadowColor='rgba(180,0,255,0.9)';
          octx.lineWidth=3; octx.beginPath(); octx.arc(cx,cy,18,0,Math.PI*2); octx.stroke(); octx.restore();
          anyHit=true;
        }
      }
      if(anyHit) hapticPulse();
      anim=requestAnimationFrame(loop);
    }catch(e){
      el.status.textContent='Loop error';
      cancelAnimationFrame(anim);
    }
  }

  function hueDistDeg(hDeg,ref){ let d=Math.abs(hDeg-ref)%360; if(d>180)d=360-d; return d }
  function toHSV(r,g,b){const rn=r/255,gn=g/255,bn=b/255;const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;if(d!==0){if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));else if(max===gn)h=((bn-rn)/d+2);else h=((rn-gn)/d+4);h/=6}const s=max===0?0:d/max,v=max;return {h,s,v}}
  function toYCbCr(r,g,b){const y=0.299*r+0.587*g+0.114*b;const cb=128-0.168736*r-0.331264*g+0.5*b;const cr=128+0.5*r-0.418688*g-0.081312*b;return {y,cb,cr}}
  function srgb2lin(c){c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
  function toLab(r,g,b){const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);const X=0.4124564*R+0.3575761*G+0.1804375*B;const Y=0.2126729*R+0.7151522*G+0.0721750*B;const Z=0.0193339*R+0.1191920*G+0.9503041*B;const Xn=0.95047,Yn=1.0,Zn=1.08883;const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)}}
})();