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

  // --- Debug toggles (no UI changes): press 'D' to see red mask
  let DEBUG_MASK=false;
  window.addEventListener('keydown', (e)=>{
    if(e.key==='d' || e.key==='D'){ DEBUG_MASK = !DEBUG_MASK; setStatus(DEBUG_MASK?'Debug mask on':'Streaming…'); }
  });

  // Haptics
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

  // Video / processing
  let stream=null, anim=null, frames=0, lastTS=0;
  let dispW=640, dispH=480, procW=320, procH=240;
  const proc=document.createElement('canvas'), procCtx=proc.getContext('2d',{willReadFrequently:true});
  const octx = $('overlay').getContext('2d');

  function setViewportSize(){
    dispW = el.video.videoWidth || el.viewport.clientWidth;
    dispH = el.video.videoHeight || el.viewport.clientHeight;
    el.overlay.width  = Math.max(1, dispW);
    el.overlay.height = Math.max(1, dispH);
  }
  window.addEventListener('resize', ()=>{ if(stream) setViewportSize(); });

  // Helpers
  function toYCbCr(r,g,b){
    const y=0.299*r+0.587*g+0.114*b;
    const cb=128-0.168736*r-0.331264*g+0.5*b;
    const cr=128+0.5*r-0.418688*g-0.081312*b;
    return {y,cb,cr};
  }
  function sigmoid(x){ return 1/(1+Math.exp(-x)); }

  // Aggressive scorer combining simple redness + YCbCr; avoids Lab/hue gates that reject bright reds
  function redScoreAggressive(r,g,b){
    // basic contrasts
    const dRG = r - g;
    const dRB = r - b;
    // clamp negatives
    const cRG = dRG < 0 ? 0 : dRG;
    const cRB = dRB < 0 ? 0 : dRB;
    const {y,cb,cr} = toYCbCr(r,g,b);
    const crRel = cr - 0.55*cb; // skin/blood axis
    // Normalize terms roughly to 0..1
    const nRG = cRG / 255;
    const nRB = cRB / 255;
    const nCr = (crRel - 40) / 100; // ~0 at 40, ~1 near 140
    const nY  = (y - 140) / 120;   // penalize very bright highlights
    // linear combo then squash
    const s = 1.2*nRG + 1.0*nRB + 0.9*nCr - 0.6*Math.max(0,nY);
    return sigmoid(3.2*(s-0.55)); // center ~0.55; tuneable
  }

  // components (8-neighborhood) for grouping
  function filterBlobs(binary,w,h,minArea,maxArea){
    const visited=new Uint8Array(w*h);
    function flood(start){
      const q=[start]; visited[start]=1;
      let area=0, cx=0, cy=0;
      while(q.length){
        const cur=q.pop(); area++;
        const x=cur%w, y=(cur-x)/w; cx+=x; cy+=y;
        const neigh=[cur-1,cur+1,cur-w,cur+w,cur-w-1,cur-w+1,cur+w-1,cur+w+1];
        for(const n of neigh){
          if(n<0||n>=w*h) continue;
          if(!visited[n] && binary[n]){ visited[n]=1; q.push(n); }
        }
      }
      return {area, centroid:{x:cx/area, y:cy/area}};
    }
    const blobs=[];
    for(let i=0;i<w*h;i++){
      if(visited[i]||!binary[i]) continue;
      const r=flood(i);
      if(r.area>=minArea && r.area<=maxArea) blobs.push(r);
    }
    return blobs;
  }

  // Start/Stop (no auto-restart)
  let starting=false;
  async function start(){
    if(stream || starting) return; starting=true;
    setStatus('Requesting camera…');
    try{
      const tries=[
        {video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false},
        {video:{facingMode:{ideal:'environment'}},audio:false},
        {video:true,audio:false}
      ];
      let s=null,lastErr='';
      for(const c of tries){ try{ s=await navigator.mediaDevices.getUserMedia(c); if(s) break; } catch(e){ lastErr=e.name||'err'; } }
      if(!s){ setStatus('Camera failed: '+lastErr); starting=false; return; }
      stream=s; el.video.srcObject=s; await el.video.play();
      setViewportSize();
      proc.width = Math.max(240, Math.round(dispW*0.5));
      proc.height= Math.max(180, Math.round(dispH*0.5));
      procW=proc.width; procH=proc.height;
      setStatus('Streaming…'); el.startBtn.textContent='Stop';
      frames=0; lastTS=performance.now();
      loop();
    }catch(e){ setStatus('Camera error: '+(e && e.name ? e.name : '')); }
    finally{ starting=false; }
  }
  function stop(){
    if(anim) cancelAnimationFrame(anim); anim=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    setStatus('Stopped.'); el.startBtn.textContent='Start';
    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
  }
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
    el.flash.style.opacity = (el.flash.style.opacity==='1'?'0':'1');
  }
  el.torchBtn.addEventListener('click', toggleTorch, true);

  el.alertBtn.addEventListener('click', e=>{
    e.stopPropagation();
    const on = el.alertBtn.getAttribute('aria-pressed')!=='true';
    el.alertBtn.setAttribute('aria-pressed', String(on));
    el.alertBtn.textContent = on ? 'Alert: On' : 'Alert: Off';
  }, true);

  function loop(ts){
    if(!stream){ cancelAnimationFrame(anim); return; }
    frames++; if(ts-lastTS>1000){ el.fps.textContent = frames+' fps'; frames=0; lastTS=ts; }

    if(el.video.videoWidth|0){ setViewportSize(); }
    procCtx.drawImage(el.video, 0, 0, procW, procH);
    const img = procCtx.getImageData(0,0,procW,procH), d=img.data;

    // Aggressive red score, then binarize
    const score = new Float32Array(procW*procH);
    let max=-1e9, min=1e9;
    for(let p=0,i=0;p<d.length;p+=4,i++){
      const s = redScoreAggressive(d[p], d[p+1], d[p+2]);
      score[i]=s; if(s>max)max=s; if(s<min)min=s;
    }
    const rng=Math.max(1e-6,max-min);
    const bin=new Uint8Array(procW*procH);
    const THR = 0.35; // permissive but avoids false flood
    for(let i=0;i<score.length;i++){
      const n=(score[i]-min)/rng;
      if(n>=THR) bin[i]=1;
    }

    // components
    const minArea = Math.max(4, Math.floor(procW*procH*0.00015));
    const maxArea = Math.floor(procW*procH*0.3);
    const blobs = filterBlobs(bin, procW, procH, minArea, maxArea);

    // draw
    octx.clearRect(0,0,el.overlay.width,el.overlay.height);

    if(DEBUG_MASK){
      // visualize the mask in red
      const mask = octx.createImageData(el.overlay.width, el.overlay.height);
      for(let y=0;y<el.overlay.height;y++){
        for(let x=0;x<el.overlay.width;x++){
          const sx = Math.floor(x*procW/el.overlay.width);
          const sy = Math.floor(y*procH/el.overlay.height);
          const idx = sy*procW+sx;
          const on = bin[idx] ? 255 : 0;
          const di = (y*el.overlay.width + x)*4;
          mask.data[di]=on; mask.data[di+1]=0; mask.data[di+2]=0; mask.data[di+3]=on?140:0;
        }
      }
      octx.putImageData(mask,0,0);
    }

    let any=false;
    // also mark top N hotspots even if blobbing failed
    if(blobs.length===0){
      // pick top 5 scores
      const idxs=[...score.keys()].sort((a,b)=>score[b]-score[a]).slice(0,5);
      for(const i of idxs){
        const x=(i%procW)*el.overlay.width/procW;
        const y=Math.floor(i/procW)*el.overlay.height/procH;
        drawRings(x,y); any=true;
      }
    }else{
      for(const b of blobs){
        const cx=b.centroid.x*el.overlay.width/procW;
        const cy=b.centroid.y*el.overlay.height/procH;
        drawRings(cx,cy); any=true;
      }
    }
    if(any) hapticPulse();
    anim = requestAnimationFrame(loop);
  }

  function drawRings(cx,cy){
    const radii=[16,26];
    octx.save();
    octx.strokeStyle='#b400ff';
    octx.lineWidth=3;
    octx.shadowBlur=10;
    octx.shadowColor='rgba(180,0,255,0.95)';
    for(const r of radii){
      octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI*2); octx.stroke();
    }
    octx.restore();
  }

  // Start/Stop exposure
  let starting=false_ref; // placeholder to avoid accidental duplicate symbol elsewhere
  async function startWrapper(){ return start(); }
  function stopWrapper(){ return stop(); }
  window.__TTD__ = { start:startWrapper, stop:stopWrapper };
})();