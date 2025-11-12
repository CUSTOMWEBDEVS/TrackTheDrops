(function(){
  const $=id=>document.getElementById(id);
  const el={
    video:$('video'), overlay:$('overlay'),
    status:$('status'), fps:$('fps'),
    startBtn:$('startBtn'), torchBtn:$('torchBtn'), alertBtn:$('alertBtn'),
    flash:$('flash'), viewport:$('viewport'), app:$('app')
  };
  const setStatus = (s)=>{ if(el.status) el.status.textContent = s; };
  setStatus('Booting… (app ok)');

  // ---- UI helpers
  let uiTimer=null;
  function showUI(){
    el.app.classList.remove('hiddenUI');
    if(uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(()=>el.app.classList.add('hiddenUI'), 2200);
  }
  ['startBtn','torchBtn','alertBtn'].forEach(id=>{
    el[id].addEventListener('click', e=>{ e.stopPropagation(); showUI(); }, true);
  });

  // ---- Haptics (vibrate fallback)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  let aCtx; try{ aCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch{}
  async function hapticPulse(){
    if (el.alertBtn.getAttribute('aria-pressed')!=='true') return;
    if ('vibrate' in navigator && !isIOS) { navigator.vibrate(40); return; }
    try{
      if(aCtx && aCtx.state==='suspended') await aCtx.resume();
      if(aCtx){
        const o=aCtx.createOscillator(), g=aCtx.createGain();
        o.type='square'; o.frequency.value=1100; g.gain.value=0.05;
        o.connect(g); g.connect(aCtx.destination); o.start(); setTimeout(()=>o.stop(),60);
      }
    }catch{}
    el.flash.style.opacity='0.45'; setTimeout(()=>el.flash.style.opacity='0',120);
  }

  // ---- Video / processing state
  let stream=null, anim=null, frames=0, lastTS=0, frameCount=0;
  let dispW=640, dispH=480, procW=320, procH=240;
  const proc=document.createElement('canvas'), procCtx=proc.getContext('2d',{willReadFrequently:true});
  const octx = el.overlay.getContext('2d');

  function setViewportSize(){
    dispW = el.video.videoWidth || el.viewport.clientWidth;
    dispH = el.video.videoHeight || el.viewport.clientHeight;
    el.overlay.width = Math.max(1, dispW);
    el.overlay.height = Math.max(1, dispH);
  }
  window.addEventListener('resize', ()=>{ if(stream) setViewportSize(); });

  // ---- Detection tuning (same character as your good build)
  const BASE={
    vMaxBase:0.66, vMin:0.08, sMinBase:0.52, hTolBase:14,
    aMinBase:34, bMaxBase:24, aDivBRatio:2.0, crRelBase:88, yMaxBase:190,
    minAreaFrac:0.0007, maxFrac:0.18
  };
  const tune = {...BASE};

  // ---- Color conversions / scoring
  function hueDistDeg(hDeg,ref){ let d=Math.abs(hDeg-ref)%360; if(d>180)d=360-d; return d; }
  function toHSV(r,g,b){
    const rn=r/255, gn=g/255, bn=b/255;
    const max=Math.max(rn,gn,bn), min=Math.min(rn,gn,bn), d=max-min; let h=0;
    if(d!==0){ if(max===rn) h=((gn-bn)/d+(gn<bn?6:0)); else if(max===gn) h=((bn-rn)/d+2); else h=((rn-gn)/d+4); h/=6; }
    const s=max===0?0:d/max, v=max; return {h,s,v};
  }
  function toYCbCr(r,g,b){
    const y=0.299*r+0.587*g+0.114*b;
    const cb=128-0.168736*r-0.331264*g+0.5*b;
    const cr=128+0.5*r-0.418688*g-0.081312*b;
    return {y,cb,cr};
  }
  function srgb2lin(c){ c/=255; return (c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4); }
  function toLab(r,g,b){
    const R=srgb2lin(r), G=srgb2lin(g), B=srgb2lin(b);
    const X=0.4124564*R+0.3575761*G+0.1804375*B;
    const Y=0.2126729*R+0.7151522*G+0.0721750*B;
    const Z=0.0193339*R+0.1191920*G+0.9503041*B;
    const Xn=0.95047, Yn=1.0, Zn=1.08883;
    const f=t=>{const d=6/29; return (t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29;};
    const fx=f(X/Xn), fy=f(Y/Yn), fz=f(Z/Zn);
    return {L:116*fy-16, a:500*(fx-fy), b:200*(fy-fz)};
  }

  function scorePixel(r,g,b,sens,t,doLab){
    if(!(r>g && g>=b)) return 0;
    const {h,s,v}=toHSV(r,g,b);
    const hDeg=h*360, hTol=t.hTolBase+10*(1-sens), sMin=t.sMinBase-0.25*(1-sens), vMax=t.vMaxBase+0.10*(1-sens);
    if(hueDistDeg(hDeg,0)>hTol || s<sMin || v<t.vMin || v>vMax) return 0;

    const r_g=r/Math.max(1,g), r_b=r/Math.max(1,b);
    if(r_g<(1.28-0.1*sens) || r_b<(1.9-0.3*sens) || (r-g)<12 || (r-b)<26) return 0;

    const {y,cb,cr}=toYCbCr(r,g,b); const crRel=cr-0.55*cb;
    if(y>t.yMaxBase+25*(1-sens) || crRel<t.crRelBase-20*(1-sens)) return 0;

    if(doLab){
      const {L,a,b:bb}=toLab(r,g,b);
      if(a<t.aMinBase-8*(1-sens) || bb>t.bMaxBase+8*(1-sens) || (a/Math.max(1e-3,bb))<t.aDivBRatio || L>64) return 0;
    }
    return 1; // binary score; threshold later
  }

  function filterBlobs(binary,w,h,t){
    const visited=new Uint8Array(w*h);
    const minArea=Math.max(6,Math.floor(w*h*t.minAreaFrac)), maxArea=Math.floor(w*h*t.maxFrac);
    function flood(start){
      const q=[start]; visited[start]=1;
      const coords=[]; let area=0, cx=0, cy=0;
      while(q.length){
        const cur=q.pop(); coords.push(cur); area++;
        const x=cur%w, y=(cur-x)/w; cx+=x; cy+=y;
        const neigh=[cur-1,cur+1,cur-w,cur+w];
        for(const n of neigh){ if(n<0||n>=w*h)continue; if(!visited[n]&&binary[n]){ visited[n]=1; q.push(n); } }
      }
      return { ok:(area>=minArea && area<=maxArea), coords, centroid:{x:cx/area, y:cy/area}, area };
    }
    const blobs=[];
    for(let i=0;i<w*h;i++){ if(visited[i]||!binary[i]) continue; const r=flood(i); if(r.ok) blobs.push(r); }
    return {blobs};
  }

  function sizeProcessingCanvas(){
    setViewportSize();
    const scale = 320/Math.max(1,dispW);
    proc.width = Math.max(160, Math.round(dispW*scale));
    proc.height = Math.max(120, Math.round(dispH*scale));
    procW = proc.width; procH = proc.height;
  }

  // ---- START / STOP
  let starting=false;
  let allowViewportStart = false; // prevent “auto restart” after Stop

  async function start(){
    if(stream || starting) return; starting=true;
    setStatus('Requesting camera…');
    try{
      // try env first, then generic; keep simple like v7
      const tries=[
        {video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false},
        {video:{facingMode:{ideal:'environment'}},audio:false},
        {video:true,audio:false}
      ];
      let s=null,lastErr='';
      for(const c of tries){ try{ s=await navigator.mediaDevices.getUserMedia(c); if(s) break; } catch(e){ lastErr=e.name||'err'; } }
      if(!s){ setStatus('Camera failed: '+lastErr); starting=false; return; }
      stream=s; el.video.srcObject=s; await el.video.play();
      sizeProcessingCanvas(); setStatus('Streaming…'); el.startBtn.textContent='Stop';
      frames=0; lastTS=performance.now(); frameCount=0;
      allowViewportStart = true; // only allowed AFTER a manual Start
      loop();
    }catch(e){ setStatus('Camera error: '+(e && e.name ? e.name : '')); }
    finally{ starting=false; }
  }

  function stop(){
    if(anim) cancelAnimationFrame(anim); anim=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    setStatus('Stopped.');
    el.startBtn.textContent='Start';
    allowViewportStart = false; // disable “tap-to-start” until Start pressed again
  }

  // Start/Stop button only; viewport click will NOT start after Stop.
  el.startBtn.addEventListener('click', e=>{ e.stopPropagation(); (stream?stop():start()); }, true);

  // Torch
  async function toggleTorch(e){
    e.stopPropagation();
    try{
      if(stream){
        const track=stream.getVideoTracks()[0];
        const caps=track.getCapabilities ? track.getCapabilities() : null;
        if(caps && ('torch' in caps)){
          const cons=track.getConstraints ? track.getConstraints() : {};
          let cur=false;
          if(cons && cons.advanced && cons.advanced.length){
            cur = !!cons.advanced.find(o=>o && o.torch===true);
          }
          const next=!cur;
          await track.applyConstraints({advanced:[{torch:next}]});
          el.torchBtn.textContent = next ? 'Flash (on)' : 'Flashlight';
          return;
        }
      }
    }catch{}
    // Fallback: quick white pulse overlay (not a real torch)
    el.flash.style.opacity = (el.flash.style.opacity==='1'?'0':'1');
  }
  el.torchBtn.addEventListener('click', toggleTorch, true);

  // Alert toggle (vibrate on/off)
  el.alertBtn.addEventListener('click', e=>{
    e.stopPropagation();
    const on = el.alertBtn.getAttribute('aria-pressed')!=='true';
    el.alertBtn.setAttribute('aria-pressed', String(on));
    el.alertBtn.textContent = on ? 'Alert: On' : 'Alert: Off';
    showUI();
  }, true);

  // Optional: viewport tap-to-start ONLY if user has already started once (prevents auto-restart after Stop)
  el.viewport.addEventListener('click', ()=>{
    if(!stream && allowViewportStart){ start(); }
    showUI();
  });

  // ---- Main loop
  function loop(ts){
    if(!stream){ cancelAnimationFrame(anim); return; }

    frames++; if(ts-lastTS>1000){ el.fps.textContent = frames+' fps'; frames=0; lastTS=ts; }
    frameCount++;

    if(el.video.videoWidth|0){ setViewportSize(); }
    procCtx.drawImage(el.video, 0, 0, procW, procH);
    const img = procCtx.getImageData(0,0,procW,procH), d=img.data;
    const sens=1.0, thr=0.15; // same behavior as your good build

    // score + normalize
    const score = new Float32Array(procW*procH);
    let max=-1e9, min=1e9;
    for(let p=0,i=0;p<d.length;p+=4,i++){
      const s = scorePixel(d[p], d[p+1], d[p+2], sens, tune, true);
      score[i]=s; if(s>max)max=s; if(s<min)min=s;
    }
    const rng=Math.max(1e-6,max-min);
    const bin=new Uint8Array(procW*procH);
    for(let i=0;i<score.length;i++){ const n=(score[i]-min)/rng; if(n>=thr) bin[i]=1; }

    // blobs
    const {blobs} = filterBlobs(bin, procW, procH, tune);

    // draw overlay
    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
    octx.drawImage(proc, 0, 0, el.overlay.width, el.overlay.height);

    // circles (purple, visible)
    let any=false;
    for(const b of blobs){
      const cx=b.centroid.x*el.overlay.width/procW;
      const cy=b.centroid.y*el.overlay.height/procH;
      octx.save();
      octx.strokeStyle='#b400ff';                // bright purple
      octx.lineWidth=3;
      octx.shadowBlur=10;
      octx.shadowColor='rgba(180,0,255,0.95)';   // glow
      octx.beginPath();
      octx.arc(cx, cy, 18, 0, Math.PI*2);
      octx.stroke();
      // add a second ring to stand out
      octx.beginPath();
      octx.arc(cx, cy, 28, 0, Math.PI*2);
      octx.stroke();
      octx.restore();
      any=true;
    }
    if(any) hapticPulse();

    anim = requestAnimationFrame(loop);
  }

  // expose for debugging if needed
  window.__TTD__ = { start, stop };
})();
