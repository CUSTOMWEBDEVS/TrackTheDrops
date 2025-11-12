(function(){
  'use strict';

  // -------- DOM --------
  const $ = id => document.getElementById(id);
  const el = {
    app: $('app'),
    viewport: $('viewport'),
    video: $('video'),
    overlay: $('overlay'),
    tapHint: $('tapHint'),
    status: $('status'),
    fps: $('fps'),
    startBtn: $('startBtn'),
    torchBtn: $('torchBtn'),
    alertBtn: $('alertBtn'),
    flash: $('flash'),
    // optional sliders (v7 UI)
    profile: $('profile'),
    sens: $('sens'),
    thr: $('thr'),
    stability: $('stability'),
    opacity: $('opacity'),
    fastMode: $('fastMode')
  };

  const octx = el.overlay ? el.overlay.getContext('2d') : null;
  const setStatus = (s)=>{ if (el.status) el.status.textContent = s; };

  // -------- Haptics (iOS-safe fallback) --------
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  let aCtx; try { aCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch {}
  async function hapticPulse(){
    // Only when user wants alert
    if (el.alertBtn && el.alertBtn.getAttribute('aria-pressed') !== 'true') return;
    if ('vibrate' in navigator && !isIOS) { navigator.vibrate(40); return; }
    try {
      if (aCtx && aCtx.state === 'suspended') await aCtx.resume();
      if (aCtx) {
        const o=aCtx.createOscillator(), g=aCtx.createGain();
        o.type='square'; o.frequency.value=1100; g.gain.value=0.05;
        o.connect(g); g.connect(aCtx.destination); o.start(); setTimeout(()=>o.stop(),60);
      }
    } catch {}
    if (el.flash){ el.flash.style.opacity='0.45'; setTimeout(()=>el.flash.style.opacity='0',120); }
  }

  // -------- Camera --------
  let stream=null, anim=null, frames=0, lastTS=0;
  let dispW=640, dispH=480, procW=320, procH=240, frameCount=0;
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });

  function setViewportSize(){
    if (!el.video || !el.overlay) return;
    dispW = el.video.videoWidth || el.viewport.clientWidth || 640;
    dispH = el.video.videoHeight || el.viewport.clientHeight || 480;
    el.overlay.width  = dispW;
    el.overlay.height = dispH;
  }
  window.addEventListener('resize', ()=>{ if(stream) setViewportSize(); });

  // -------- Tuning (kept from v7 spirit) --------
  const TUNE = {
    // normalized score threshold (0..1)
    // use slider value if present
    thr(){ return el.thr ? Number(el.thr.value)/100 : 0.35; },
    // stability frames required for a pixel to be considered stable
    stab(){ return el.stability ? Math.max(1, Number(el.stability.value)) : 1; },
    // sensitivity for gating (0..1)
    sens(){ return el.sens ? Number(el.sens.value)/100 : 1.0; },
    // overlay alpha (0..1) if mask used
    alpha(){ return el.opacity ? Number(el.opacity.value)/100 : 0.8; }
  };

  // -------- Color helpers (single definitions; no duplicates) --------
  function toYCbCr(r,g,b){
    const y  = 0.299*r + 0.587*g + 0.114*b;
    const cb = 128 - 0.168736*r - 0.331264*g + 0.5*b;
    const cr = 128 + 0.5*r - 0.418688*g - 0.081312*b;
    return {y, cb, cr};
  }
  function rednessScore(r,g,b){
    // Fast aggressive score that survives bright white balance shifts
    // Components: R-G, R-B, Cr' (skin/blood axis), penalize very bright Y
    const dRG = Math.max(0, r - g);
    const dRB = Math.max(0, r - b);
    const {y, cb, cr} = toYCbCr(r,g,b);
    const crRel = cr - 0.55*cb; // higher => red-biased chroma
    const nRG = dRG/255;
    const nRB = dRB/255;
    const nCr = (crRel - 40) / 100;     // ~0 around 40, ~1 near 140
    const yPenalty = Math.max(0, (y - 170) / 100); // strong penalty for highlights
    let s = 1.1*nRG + 0.9*nRB + 0.9*nCr - 0.7*yPenalty;
    // squash to 0..1
    s = 1/(1+Math.exp(-3.3*(s-0.52)));
    // clamp
    return s<0?0:s>1?1:s;
  }

  // 8-connected components
  function findBlobs(binary,w,h,minArea,maxArea){
    const visited = new Uint8Array(w*h);
    const blobs = [];
    function flood(start){
      const q=[start]; visited[start]=1;
      let area=0, cx=0, cy=0;
      const coords=[];
      while(q.length){
        const cur=q.pop(); coords.push(cur); area++;
        const x=cur%w, y=(cur-x)/w; cx+=x; cy+=y;
        const neigh=[cur-1,cur+1,cur-w,cur+w,cur-w-1,cur-w+1,cur+w-1,cur+w+1];
        for(const n of neigh){
          if(n<0||n>=w*h) continue;
          if(!visited[n] && binary[n]){ visited[n]=1; q.push(n); }
        }
      }
      return { area, centroid:{x:cx/area, y:cy/area}, coords };
    }
    for(let i=0;i<w*h;i++){
      if(visited[i] || !binary[i]) continue;
      const r = flood(i);
      if (r.area>=minArea && r.area<=maxArea) blobs.push(r);
    }
    return blobs;
  }

  // -------- Start/Stop (no auto-restart after Stop) --------
  let starting=false;
  async function start(){
    if (stream || starting) return; starting=true;
    setStatus('Requesting camera…');
    try{
      const tries=[
        {video:{facingMode:{exact:'environment'}, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}}, audio:false},
        {video:{facingMode:{ideal:'environment'}}, audio:false},
        {video:true, audio:false}
      ];
      let s=null,lastErr='';
      for(const c of tries){ try{ s=await navigator.mediaDevices.getUserMedia(c); if(s) break; } catch(e){ lastErr=e.name||'err'; } }
      if(!s){ setStatus('Camera failed: '+lastErr); starting=false; return; }
      stream=s;
      if (el.video){ el.video.srcObject=s; await el.video.play().catch(()=>{}); }
      setViewportSize();
      // processing res ~1/2 width
      procW = Math.max(240, Math.round(el.overlay.width*0.5));
      procH = Math.max(180, Math.round(el.overlay.height*0.5));
      proc.width = procW; proc.height = procH;
      frames=0; lastTS=performance.now(); frameCount=0;
      if (el.tapHint) el.tapHint.style.display='none';
      setStatus('Streaming…');
      loop();
    }catch(e){
      setStatus('Camera error');
    } finally { starting=false; }
  }
  function stop(){
    if (anim) cancelAnimationFrame(anim); anim=null;
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    if (octx){ octx.clearRect(0,0,el.overlay.width, el.overlay.height); }
    if (el.tapHint) el.tapHint.style.display='';
    setStatus('Stopped.');
  }

  if (el.startBtn) el.startBtn.addEventListener('click', e=>{ e.stopPropagation(); stream?stop():start(); }, true);
  // viewport tap: UI only — never auto-start
  if (el.viewport) el.viewport.addEventListener('click', ()=>{
    // UI toggle could go here; we keep it no-op to avoid accidental start
  }, true);
  if (el.tapHint) el.tapHint.addEventListener('click', ()=>{ if(!stream) start(); }, true);

  // Torch
  async function toggleTorch(){
    try{
      if(stream){
        const track=stream.getVideoTracks()[0];
        const caps=track.getCapabilities?.();
        if (caps && 'torch' in caps){
          const cons=track.getConstraints?.() || {};
          let cur=false;
          if (cons.advanced && cons.advanced.length){
            cur = !!cons.advanced.find(o=>o && o.torch===true);
          }
          const next=!cur;
          await track.applyConstraints({ advanced:[{ torch: next }] });
          if (el.torchBtn) el.torchBtn.textContent = next ? 'Flash (on)' : 'Flashlight';
          return;
        }
      }
    }catch{}
    if (el.flash) el.flash.style.opacity = (el.flash.style.opacity==='1' ? '0' : '1');
  }
  if (el.torchBtn) el.torchBtn.addEventListener('click', e=>{ e.stopPropagation(); toggleTorch(); }, true);

  if (el.alertBtn){
    el.alertBtn.addEventListener('click', e=>{
      e.stopPropagation();
      const on = el.alertBtn.getAttribute('aria-pressed')!=='true';
      el.alertBtn.setAttribute('aria-pressed', String(on));
      el.alertBtn.textContent = on ? 'Alert: On' : 'Alert: Off';
    }, true);
  }

  // -------- Loop --------
  // stability
  let persist=null, stableMask=null;
  function loop(ts){
    if(!stream){ cancelAnimationFrame(anim); return; }
    frames++; if (ts - lastTS > 1000){ if (el.fps) el.fps.textContent = frames+' fps'; frames=0; lastTS=ts; }
    frameCount++;
    // draw frame to proc
    pctx.drawImage(el.video, 0, 0, procW, procH);
    const img = pctx.getImageData(0,0,procW,procH), d=img.data;

    const score = new Float32Array(procW*procH);
    let max=-1e9, min=1e9;
    for (let p=0,i=0; p<d.length; p+=4, i++){
      const s = rednessScore(d[p], d[p+1], d[p+2]);
      score[i]=s; if(s>max)max=s; if(s<min)min=s;
    }
    const rng = Math.max(1e-6, max - min);
    const thr = TUNE.thr();
    const bin = new Uint8Array(procW*procH);
    for (let i=0;i<score.length;i++){ const n=(score[i]-min)/rng; if (n>=thr) bin[i]=1; }

    // stability accumulate
    if (!persist){ persist=new Uint8Array(procW*procH); stableMask=new Uint8Array(procW*procH); }
    const need = TUNE.stab();
    for (let i=0;i<bin.length;i++){
      if (bin[i]) persist[i] = Math.min(255, persist[i]+1);
      else persist[i] = Math.max(0, persist[i]-1);
      stableMask[i] = persist[i] >= need ? 1 : 0;
    }

    // find blobs on stableMask (not raw bin) to avoid flicker
    const minArea = Math.max(4, Math.floor(procW*procH*0.00015));
    const maxArea = Math.floor(procW*procH*0.25);
    const blobs = findBlobs(stableMask, procW, procH, minArea, maxArea);

    // draw
    if (octx){
      octx.clearRect(0,0,el.overlay.width, el.overlay.height);
      // faint mask blend (keep v7 feel — not required for circles but helpful)
      const alpha = TUNE.alpha();
      if (alpha > 0){
        const mask = pctx.createImageData(procW, procH);
        const md = mask.data;
        for (let i=0, p=0; i<stableMask.length; i++, p+=4){
          if (stableMask[i]){
            md[p]=235; md[p+1]=20; md[p+2]=20; md[p+3]=Math.floor(alpha*255);
          }
        }
        pctx.putImageData(mask,0,0);
        octx.drawImage(proc, 0,0, el.overlay.width, el.overlay.height);
      }
      // purple circles per blob
      let any=false;
      for (const b of blobs){
        const cx = b.centroid.x * el.overlay.width / procW;
        const cy = b.centroid.y * el.overlay.height / procH;
        octx.save();
        octx.strokeStyle = '#b400ff';
        octx.lineWidth = 3;
        octx.shadowBlur = 10;
        octx.shadowColor = 'rgba(180,0,255,0.95)';
        octx.beginPath(); octx.arc(cx, cy, 18, 0, Math.PI*2); octx.stroke();
        octx.beginPath(); octx.arc(cx, cy, 28, 0, Math.PI*2); octx.stroke();
        octx.restore();
        any = true;
      }
      if (any) hapticPulse();
    }

    anim = requestAnimationFrame(loop);
  }

  // -------- Boot text --------
  setStatus('Booting… (app ok)');

  // Expose for quick manual control in console
  window.__TTD__ = { start, stop };

})();