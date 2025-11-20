(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const el={
    app:$('app'),
    viewport:$('viewport'),
    video:$('video'),
    overlay:$('overlay'),
    tapHint:$('tapHint'),
    status:$('status'),
    fps:$('fps'),
    startBtn:$('startBtn'),
    torchBtn:$('torchBtn'),
    alertBtn:$('alertBtn'),
    flash:$('flash'),
    sens:$('sens'),
    thr:$('thr'),
    stability:$('stability'),
    opacity:$('opacity'),
    installBtn:$('installBtn'),
    installShell:$('installShell'),
    installSteps:$('installSteps'),
    installClose:$('installClose'),
  };

  const setStatus=s=>{ if(el.status) el.status.textContent=s };
  const octx=el.overlay.getContext('2d');
  let stream=null, anim=null, lastTS=0, frames=0;
  let procW=320, procH=240;
  const proc=document.createElement('canvas'), pctx=proc.getContext('2d',{willReadFrequently:true});

  // ---------- Haptics ---------
  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent);
  let aCtx; try{ aCtx=new (window.AudioContext||window.webkitAudioContext)() }catch{}
  async function pulse(){
    if(el.alertBtn && el.alertBtn.getAttribute('aria-pressed')!=='true') return;
    if('vibrate' in navigator && !isIOS){ navigator.vibrate(40); return; }
    try{
      if(aCtx && aCtx.state==='suspended') await aCtx.resume();
      if(aCtx){
        const o=aCtx.createOscillator(),g=aCtx.createGain();
        o.type='square'; o.frequency.value=1100; g.gain.value=0.05;
        o.connect(g); g.connect(aCtx.destination); o.start(); setTimeout(()=>o.stop(),60);
      }
    }catch{}
    if(el.flash){ el.flash.style.opacity='0.45'; setTimeout(()=>el.flash.style.opacity='0',120); }
  }

  // ---------- Color helpers ----------
  function toHSV(r,g,b){
    const rn=r/255,gn=g/255,bn=b/255;
    const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;
    if(d){
      if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));
      else if(max===gn)h=((bn-rn)/d+2);
      else h=((rn-gn)/d+4);
      h/=6;
    }
    const s=max===0?0:d/max,v=max;
    return {h,s,v};
  }
  function toYCbCr(r,g,b){
    const y=0.299*r+0.587*g+0.114*b;
    const cb=128-0.168736*r-0.331264*g+0.5*b;
    const cr=128+0.5*r-0.418688*g-0.081312*b;
    return {y,cb,cr};
  }
  function srgb2lin(c){
    c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4);
  }
  function toLab(r,g,b){
    const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);
    const X=0.4124564*R+0.3575761*G+0.1804375*B;
    const Y=0.2126729*R+0.7151522*G+0.0721750*B;
    const Z=0.0193339*R+0.1191920*G+0.9503041*B;
    const Xn=0.95047,Yn=1.0,Zn=1.08883;
    const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};
    const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);
    return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)};
  }
  const hueDist=(deg,ref)=>{let d=Math.abs(deg-ref)%360;return d>180?360-d:d};

  // Slightly relaxed “is-blood-like” boolean gate
  function isBloodish(r,g,b,sens){
    if(!(r>g && g>=b)) return 0;
    const {h,s,v}=toHSV(r,g,b); const hDeg=h*360;
    const hTol = 14 + 6*(1-sens);                 // widen hue window a bit
    if(hueDist(hDeg,0)>hTol) return 0;
    if(s < (0.53 - 0.10*(sens))) return 0;        // allow slightly lower saturation
    if(v < 0.08 || v > (0.70 + 0.04*(1-sens))) return 0; // allow brighter dark reds but still cap bright highlights

    // Channel dominance (slightly looser)
    if((r-g) < 12 || (r-b) < 20) return 0;

    // YCbCr: lower Cr' threshold, raise Y cap a touch
    const {y,cb,cr}=toYCbCr(r,g,b);
    const crRel = cr - 0.55*cb;
    if (crRel < (85 - 8*sens)) return 0;
    if (y > (192 + 8*(1-sens))) return 0;

    // Lab anti-plastic loosened
    const L = toLab(r,g,b);
    if (L.a < (30 - 6*(1-sens)) || L.b > (26 + 6*(1-sens)) || L.L > 72) return 0;

    return 1;
  }

  function blobs(binary,w,h,minArea,maxArea){
    const vis=new Uint8Array(w*h), out=[];
    function flood(s){
      const q=[s]; vis[s]=1; let area=0,cx=0,cy=0;
      while(q.length){
        const i=q.pop(); area++;
        const x=i%w,y=(i-x)/w; cx+=x; cy+=y;
        const ns=[i-1,i+1,i-w,i+w,i-w-1,i-w+1,i+w-1,i+w+1];
        for(const n of ns){
          if(n<0||n>=w*h) continue;
          if(!vis[n] && binary[n]){ vis[n]=1; q.push(n); }
        }
      }
      return {area, centroid:{x:cx/area,y:cy/area}};
    }
    for(let i=0;i<w*h;i++){
      if(!vis[i] && binary[i]){
        const r=flood(i);
        if(r.area>=minArea && r.area<=maxArea) out.push(r);
      }
    }
    return out;
  }

  function setSizes(){
    const W=el.video.videoWidth||el.viewport.clientWidth||640;
    const H=el.video.videoHeight||el.viewport.clientHeight||480;
    el.overlay.width=W; el.overlay.height=H;
    procW=Math.max(240, Math.round(W*0.5)); procH=Math.max(180, Math.round(H*0.5));
    proc.width=procW; proc.height=procH;
  }
  window.addEventListener('resize',()=>{ if(stream) setSizes() });

  let starting=false;
  async function start(){
    if(stream||starting) return; starting=true; setStatus('Requesting camera…');
    try{
      const tries=[
        {video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false},
        {video:{facingMode:{ideal:'environment'}},audio:false},
        {video:true,audio:false},
      ]; let s=null;
      for(const c of tries){
        try{ s=await navigator.mediaDevices.getUserMedia(c); if(s)break; }catch{}
      }
      if(!s){ setStatus('Camera failed'); starting=false; return; }
      stream=s; el.video.srcObject=s; await el.video.play().catch(()=>{});
      setSizes(); frames=0; lastTS=performance.now();
      if(el.tapHint) el.tapHint.style.display='none'; setStatus('Streaming…'); loop();
    }catch{
      setStatus('Camera error');
    } finally{
      starting=false;
    }
  }
  function stop(){
    cancelAnimationFrame(anim); anim=null;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
    if(el.tapHint) el.tapHint.style.display=''; setStatus('Stopped.');
  }

  el.startBtn?.addEventListener('click',e=>{ e.stopPropagation(); stream?stop():start(); },true);
  el.tapHint?.addEventListener('click',()=>{ if(!stream) start(); },true);
  el.viewport?.addEventListener('click',()=>{},true);

  async function torch(){
    try{
      if(stream){
        const t=stream.getVideoTracks()[0], caps=t.getCapabilities?.();
        if(caps && 'torch' in caps){
          const cons=t.getConstraints?.()||{};
          const cur=!!(cons.advanced||[]).find(o=>o&&o.torch===true);
          await t.applyConstraints({advanced:[{torch:!cur}]}); return;
        }
      }
    }catch{}
    if(el.flash) el.flash.style.opacity=(el.flash.style.opacity==='1'?'0':'1');
  }
  el.torchBtn?.addEventListener('click',e=>{ e.stopPropagation(); torch(); },true);
  el.alertBtn?.addEventListener('click',e=>{
    e.stopPropagation();
    const on=el.alertBtn.getAttribute('aria-pressed')!=='true';
    el.alertBtn.setAttribute('aria-pressed',String(on));
    el.alertBtn.textContent=on?'Alert: On':'Alert: Off';
  },true);

  let persist=null, stable=null;
  function loop(ts){
    if(!stream){ cancelAnimationFrame(anim); return; }
    frames++;
    if(ts-lastTS>1000){
      if (el.fps) el.fps.textContent=frames+' fps';
      frames=0; lastTS=ts;
    }

    pctx.drawImage(el.video,0,0,procW,procH);
    const img=pctx.getImageData(0,0,procW,procH), d=img.data;
    // Use your older “good” feel: Sens ~0.70, Thr ~0.65, Stability ~2
    const sens = el.sens ? Number(el.sens.value)/100 : 0.70;
    const thr  = el.thr  ? Number(el.thr.value)/100  : 0.65;
    const need = el.stability ? Math.max(1, Number(el.stability.value)) : 2;
    const alpha= el.opacity ? Number(el.opacity.value)/100 : 0.60;

    const score=new Float32Array(procW*procH);
    let max=-1e9,min=1e9;
    for(let p=0,i=0;p<d.length;p+=4,i++){
      const s=isBloodish(d[p],d[p+1],d[p+2],sens)?1:0;
      score[i]=s; if(s>max)max=s; if(s<min)min=s;
    }
    const rng=Math.max(1e-6,max-min);
    const bin=new Uint8Array(procW*procH);
    for(let i=0;i<score.length;i++){
      const n=(score[i]-min)/rng;
      if(n>=thr) bin[i]=1;
    }

    if(!persist){ persist=new Uint8Array(procW*procH); stable=new Uint8Array(procW*procH); }
    for(let i=0;i<bin.length;i++){
      persist[i]=bin[i]?Math.min(255,persist[i]+1):Math.max(0,persist[i]-1);
      stable[i]=(persist[i]>=need)?1:0;
    }

    const minArea=Math.max(6, Math.floor(procW*procH*0.00018));
    const maxArea=Math.floor(procW*procH*0.16);
    const found=blobs(stable,procW,procH,minArea,maxArea);

    octx.clearRect(0,0,el.overlay.width,el.overlay.height);
    if(alpha>0){
      const mask=pctx.createImageData(procW,procH), md=mask.data;
      for(let i=0,p=0;i<stable.length;i++,p+=4){
        if(stable[i]){
          md[p]=235; md[p+1]=20; md[p+2]=20; md[p+3]=Math.floor(alpha*255);
        }
      }
      pctx.putImageData(mask,0,0);
      octx.drawImage(proc,0,0,el.overlay.width,el.overlay.height);
    }
    let any=false;
    for(const b of found){
      const cx=b.centroid.x*el.overlay.width/procW, cy=b.centroid.y*el.overlay.height/procH;
      octx.save(); octx.strokeStyle='#b400ff'; octx.lineWidth=3; octx.shadowBlur=10; octx.shadowColor='rgba(180,0,255,0.95)';
      octx.beginPath(); octx.arc(cx,cy,18,0,Math.PI*2); octx.stroke();
      octx.beginPath(); octx.arc(cx,cy,28,0,Math.PI*2); octx.stroke(); octx.restore(); any=true;
    }
    if(any) pulse();
    anim=requestAnimationFrame(loop);
  }

  // --- PWA / "Add to Home Screen" helper UI ---

  // If we’re already running as an installed app, hide the install button.
  const isStandalone =
    window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator && window.navigator.standalone);
  if (isStandalone && el.installBtn) {
    el.installBtn.style.display='none';
  }

  let deferredPrompt=null;

  // Capture Android/desktop PWA install prompt when the browser decides we’re installable
  window.addEventListener('beforeinstallprompt', e=>{
    e.preventDefault();
    deferredPrompt=e;
    if(el.installBtn){
      el.installBtn.disabled=false;
      el.installBtn.textContent='Install app';
    }
  });

  function openInstallHelp(){
    if(!el.installShell) return;
    el.installShell.classList.add('show');
    el.installShell.setAttribute('aria-hidden','false');
  }
  function closeInstallHelp(){
    if(!el.installShell) return;
    el.installShell.classList.remove('show');
    el.installShell.setAttribute('aria-hidden','true');
  }

  el.installBtn?.addEventListener('click', ev=>{
    ev.stopPropagation();
    openInstallHelp();
  }, true);

  el.installShell?.addEventListener('click', ev=>{
    if(ev.target===el.installShell){
      closeInstallHelp();
    }
  }, true);

  el.installClose?.addEventListener('click', ev=>{
    ev.stopPropagation();
    closeInstallHelp();
  }, true);

  const osButtons=document.querySelectorAll('.install-os[data-os]');
  osButtons.forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(!el.installSteps) return;
      const os=btn.dataset.os;
      if(os==='android'){
        // Try the real PWA install prompt if we caught it
        if(deferredPrompt){
          try{
            deferredPrompt.prompt();
            const choice=await deferredPrompt.userChoice;
            if(choice && choice.outcome==='accepted'){
              el.installSteps.innerHTML=
                '<p>Nice. Your browser will add TrackTheDrop to your home screen. ' +
                'After that you can close this tab and launch it from the icon like any other app.</p>';
            }else{
              el.installSteps.innerHTML=
                '<p>If you skipped the dialog, you can still install manually: open your browser menu and pick ' +
                '<strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>';
            }
          }catch(_){}
          deferredPrompt=null;
        }else{
          // Fallback manual steps
          el.installSteps.innerHTML=
            '<ol>' +
              '<li>Open this page in <strong>Chrome</strong> on your phone.</li>' +
              '<li>Tap the <strong>⋮</strong> menu (top-right).</li>' +
              '<li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>' +
              '<li>Confirm the name and tap <strong>Add</strong>.</li>' +
            '</ol>';
        }
      }else if(os==='ios'){
        // iOS: Safari only, manual.
        el.installSteps.innerHTML=
          '<ol>' +
            '<li>Open this page in <strong>Safari</strong>.</li>' +
            '<li>Tap the <strong>Share</strong> button (square with an up arrow).</li>' +
            '<li>Scroll and tap <strong>Add to Home Screen</strong>.</li>' +
            '<li>Tap <strong>Add</strong> in the top right.</li>' +
          '</ol>' +
          '<p>After that TrackTheDrop will live on your home screen and run full-screen offline.</p>';
      }else{
        // Other browsers/platforms
        el.installSteps.innerHTML=
          '<ol>' +
            '<li>Open this page in your browser.</li>' +
            '<li>Open the main menu.</li>' +
            '<li>Look for <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>' +
            '<li>Confirm to add the icon.</li>' +
          '</ol>';
      }
    });
  });

  setStatus('Booting… (relaxed strict)');
  window.__TTD__={
    start:()=>{ if(!stream) start(); },
    stop:()=>{ if(stream) stop(); }
  };
})();
