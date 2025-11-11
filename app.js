(function(){
  const el = {
    video: document.getElementById('video'),
    view: document.getElementById('view'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    snapBtn: document.getElementById('snapBtn'),
    showMask: document.getElementById('showMask'),
    debugHeat: document.getElementById('debugHeat'),
    thr: document.getElementById('thr'),
    thrVal: document.getElementById('thrVal'),
    sens: document.getElementById('sens'),
    sensVal: document.getElementById('sensVal'),
    msg: document.getElementById('msg')
  };

  function setMsg(s){ console.log('[ttd]', s); el.msg.textContent = s; }
  function bindSlider(sl, label){ const render=()=>label.textContent=sl.value; sl.addEventListener('input', render); render(); }
  bindSlider(el.thr, el.thrVal); bindSlider(el.sens, el.sensVal);

  let stream=null, anim=null;
  let W=640,H=480;

  async function start(){
    if(stream) return;
    try{
      setMsg('Requesting camera…');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio:false });
    }catch(err){
      setMsg('Camera error: '+err.name+' — '+err.message+'\nOpen in Safari (not in-app), over HTTPS, and allow camera.');
      return;
    }
    el.video.srcObject = stream;
    try { await el.video.play(); } catch {}
    W = el.video.videoWidth || 640;
    H = el.video.videoHeight || 480;
    const ctx = el.view.getContext('2d', { willReadFrequently:true });
    el.view.width = W; el.view.height = H;

    el.startBtn.disabled = true; el.stopBtn.disabled = false; el.snapBtn.disabled = false;
    setMsg('Streaming…');

    const tick = ()=>{
      if(!stream){ cancelAnimationFrame(anim); return; }
      ctx.drawImage(el.video, 0, 0, W, H);
      if (el.showMask.checked || el.debugHeat.checked) process(ctx, W, H);
      anim = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop(){
    if(anim) cancelAnimationFrame(anim);
    if(stream) { stream.getTracks().forEach(t=>t.stop()); stream=null; }
    el.startBtn.disabled = false; el.stopBtn.disabled = true; el.snapBtn.disabled = true;
    setMsg('Stopped.');
  }

  function snapshot(){
    const a = document.createElement('a');
    a.download = `trackthedrop_${Date.now()}.png`;
    a.href = el.view.toDataURL('image/png'); a.click();
  }

  function process(ctx, W, H){
    const thr = Number(el.thr.value)/100;
    const sens = Number(el.sens.value)/100;
    const debug = el.debugHeat.checked;
    const showMask = el.showMask.checked;

    const img = ctx.getImageData(0,0,W,H);
    const d = img.data;
    const heat = new Float32Array(W*H);
    let min=1e9, max=-1e9;

    for(let p=0,i=0;p<d.length;p+=4,i++){
      const r=d[p], g=d[p+1], b=d[p+2];
      const sum = r+g+b+1e-6;
      const normR = r / sum;
      const rgDiff = Math.max(0, (r-g)/255);
      const maxc=Math.max(r,g,b), minc=Math.min(r,g,b); const delta=maxc-minc;
      const sat = maxc===0?0:delta/maxc;
      const val = maxc/255;
      const vGate = Math.max(0.0, val - (0.25*(1-sens)));
      let hval = 0.62*normR + 0.25*rgDiff + 0.13*sat;
      hval *= vGate;
      heat[i]=hval;
      if(hval<min)min=hval; if(hval>max)max=hval;
    }
    const scale = 1/Math.max(1e-6, max-min);

    for(let p=0,i=0;p<d.length;p+=4,i++){
      const n=(heat[i]-min)*scale;
      const on = n>=thr;
      if(debug){
        d[p] = Math.min(255, n*255); d[p+1]=0; d[p+2]=Math.min(255,(1-n)*255);
      } else if (showMask && on){
        d[p] = Math.max(d[p],220); d[p+1] = Math.min(d[p+1],30); d[p+2] = Math.min(d[p+2],30);
      } else {
        d[p] = (d[p]*0.9)|0; d[p+1]=(d[p+1]*0.93)|0; d[p+2]=(d[p+2]*0.95)|0;
      }
    }
    ctx.putImageData(img,0,0);
  }

  el.startBtn.addEventListener('click', start);
  el.stopBtn.addEventListener('click', stop);
  el.snapBtn.addEventListener('click', snapshot);

  // register SW (optional)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  // prove JS loaded
  setMsg('JS loaded. Tap Start.');
})();