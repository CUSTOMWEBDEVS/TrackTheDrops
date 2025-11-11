(function () {
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
  function bindSlider(sl,label){ const r=()=>label.textContent=sl.value; sl.addEventListener('input',r); r(); }
  bindSlider(el.thr, el.thrVal); bindSlider(el.sens, el.sensVal);

  let stream=null, anim=null, W=640, H=480;

  // ---------- Color utilities ----------
  function toHSV(r,g,b){
    const rn=r/255, gn=g/255, bn=b/255;
    const max=Math.max(rn,gn,bn), min=Math.min(rn,gn,bn), d=max-min;
    let h=0;
    if (d !== 0){
      if (max===rn) h=((gn-bn)/d + (gn<bn?6:0));
      else if (max===gn) h=((bn-rn)/d + 2);
      else h=((rn-gn)/d + 4);
      h/=6;
    }
    const s=max===0?0:d/max;
    const v=max;
    return {h,s,v}; // h in [0,1)
  }
  function toYCbCr(r,g,b){ // BT.601
    const y  =  0.299*r + 0.587*g + 0.114*b;
    const cb = 128 - 0.168736*r - 0.331264*g + 0.5*b;
    const cr = 128 + 0.5*r - 0.418688*g - 0.081312*b;
    return {y,cb,cr};
  }

  // Helper: circular hue distance in degrees
  function hueDistDeg(hDeg, refDeg){
    let d = Math.abs(hDeg - refDeg) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  // Ref “blood red” anchors (from your note)
  const REF = {
    rgb: {r:138,g:3,b:3},
    hsv: {hDeg: 0, s: 0.98, v: 0.54},
    ycbcr: {y:43, cr: 200, cb: 105} // computed with BT.601 from (138,3,3)
  };

  // Scoring function: 0..1
  function bloodScore(r,g,b, sensGate){ // sensGate in [0..1]
    // Fast structural reject
    if (!(r > g && g >= b)) return 0;

    // HSV gates: hue near 0°, S high, V not too bright
    const {h,s,v} = toHSV(r,g,b);
    const hDeg = h*360;
    const hTol = 12 + 10*(1-sensGate);        // 12–22° tolerance
    const hueOK = (hueDistDeg(hDeg, 0) <= hTol);
    const sMin  = 0.6 - 0.25*(1-sensGate);    // >= 0.35..0.6
    const sOK = s >= sMin;
    const vMax = 0.62 + 0.08*(1-sensGate);    // <= 0.62..0.70
    const vMin = 0.12;                        // avoid near-black noise
    const vOK = v >= vMin && v <= vMax;
    if (!(hueOK && sOK && vOK)) return 0;

    // RGB dominance/ratio gates (tuned)
    const r_g = r/Math.max(1,g);
    const r_b = r/Math.max(1,b);
    const gapRG = r-g, gapRB = r-b;
    const ratioOK = (r_g >= 1.30 - 0.10*(sensGate)) && (r_b >= 2.00 - 0.30*(sensGate)) && (gapRG >= 14) && (gapRB >= 28);
    if (!ratioOK) return 0;

    // YCbCr gate: high Cr relative to Cb and not too bright Y
    const {y,cb,cr} = toYCbCr(r,g,b);
    const yOK  = y <= 185 + 20*(1-sensGate);           // keep darker/mid luminance
    const crOK = cr >= 160 - 20*(1-sensGate);
    const crRel = (cr - 0.55*cb);                      // penalize pinks (high Cb)
    const crRelOK = crRel >= 90 - 20*(1-sensGate);
    if (!(yOK && crOK && crRelOK)) return 0;

    // Distance to reference in hybrid space (HSV hue + ratios + YCbCr)
    const hueScore = Math.max(0, 1 - hueDistDeg(hDeg, REF.hsv.hDeg) / (hTol+1));
    const satScore = Math.min(1, (s - 0.35)/0.5);
    const valScore = Math.min(1, (0.75 - v)/0.4);      // darker -> higher
    const crCbScore = Math.min(1, (crRel - 80)/80);
    const ratioScore = Math.min(1, ((r_b-1.6)/1.5 + (r_g-1.15)/0.7)/2);

    // Weighted sum → tune weights to taste
    let score = 0;
    score += 0.30*hueScore;
    score += 0.18*satScore;
    score += 0.18*valScore;
    score += 0.22*crCbScore;
    score += 0.12*ratioScore;

    // Clamp
    return Math.max(0, Math.min(1, score));
  }

  // Simple blob filter to reject huge flats (doors) and tiny noise; also drop bright blobs
  function filterBlobs(binary, w, h, imgData){
    const visited = new Uint8Array(w*h);
    const keep = new Uint8Array(w*h);
    const px = imgData.data;
    const minArea = 150;
    const maxFrac = 0.15; // 15% of frame
    const maxArea = Math.floor(w*h*maxFrac);

    for (let y=0; y<h; y++){
      for (let x=0; x<w; x++){
        const idx = y*w + x;
        if (visited[idx] || !binary[idx]) continue;

        // BFS
        const q = [idx];
        visited[idx]=1;
        let area=0, sumV=0;
        const coords = [];

        while (q.length){
          const cur = q.pop();
          coords.push(cur);
          area++;
          const p = cur*4;
          const r=px[p], g=px[p+1], b=px[p+2];
          const v = Math.max(r,g,b)/255;
          sumV += v;

          const cx = cur % w, cy = (cur - cx)/w;
          const nb = [cur-1, cur+1, cur-w, cur+w];
          for (const n of nb){
            if (n<0 || n>=w*h) continue;
            const nx = n % w, ny = (n - nx)/w;
            if (Math.abs(nx-cx)+Math.abs(ny-cy) !== 1) continue;
            if (!visited[n] && binary[n]){ visited[n]=1; q.push(n); }
          }
        }

        const meanV = sumV / Math.max(1, area);
        const ok = (area>=minArea) && (area<=maxArea) && (meanV <= 0.60);
        if (ok) for (const id of coords) keep[id]=1;
      }
    }
    return keep;
  }

  async function start(){
    if (stream) return;
    try{
      setMsg('Requesting camera…');
      stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' } }, audio:false });
    }catch(err){
      setMsg('Camera error: '+err.name+' — '+err.message+'\nOpen in Safari, allow camera.');
      return;
    }
    el.video.srcObject = stream;
    try{ await el.video.play(); }catch{}
    W = el.video.videoWidth || 640; H = el.video.videoHeight || 480;
    const ctx = el.view.getContext('2d', { willReadFrequently:true });
    el.view.width = W; el.view.height = H;

    el.startBtn.disabled=true; el.stopBtn.disabled=false; el.snapBtn.disabled=false;
    setMsg('Streaming…');

    const tick = ()=>{
      if(!stream){ cancelAnimationFrame(anim); return; }
      ctx.drawImage(el.video, 0, 0, W, H);

      if (el.showMask.checked || el.debugHeat.checked){
        const img = ctx.getImageData(0,0,W,H);
        const d = img.data;
        const sens = Number(el.sens.value)/100;
        const thr = Number(el.thr.value)/100;

        const score = new Float32Array(W*H);
        let min=1e6, max=-1e6;
        for (let p=0,i=0; p<d.length; p+=4,i++){
          const s = bloodScore(d[p], d[p+1], d[p+2], sens);
          score[i]=s;
          if (s<min) min=s; if (s>max) max=s;
        }
        const rng = Math.max(1e-6, max-min);

        const bin = new Uint8Array(W*H);
        for (let i=0;i<score.length;i++){
          const n = (score[i]-min)/rng;
          if (n>=thr) bin[i]=1;
        }

        const kept = filterBlobs(bin, W, H, img);

        for (let p=0,i=0; p<d.length; p+=4, i++){
          if (el.debugHeat.checked){
            const n = (score[i]-min)/rng;
            d[p] = Math.min(255, n*255); d[p+1]=0; d[p+2]=Math.min(255,(1-n)*255); d[p+3]=255;
          } else if (kept[i]){
            d[p]=Math.max(d[p],220); d[p+1]=Math.min(d[p+1],30); d[p+2]=Math.min(d[p+2],30);
          } else {
            d[p]=(d[p]*0.88)|0; d[p+1]=(d[p+1]*0.92)|0; d[p+2]=(d[p+2]*0.95)|0;
          }
        }
        ctx.putImageData(img,0,0);
      }

      anim = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop(){
    if (anim) cancelAnimationFrame(anim);
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    el.startBtn.disabled=false; el.stopBtn.disabled=true; el.snapBtn.disabled=true;
    setMsg('Stopped.');
  }

  function snapshot(){
    const a=document.createElement('a');
    a.download=`trackthedrop_${Date.now()}.png`;
    a.href=el.view.toDataURL('image/png'); a.click();
  }

  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  el.startBtn.addEventListener('click', start);
  el.stopBtn.addEventListener('click', stop);
  el.snapBtn.addEventListener('click', snapshot);
  setMsg('JS loaded. Tap Start.');
})();