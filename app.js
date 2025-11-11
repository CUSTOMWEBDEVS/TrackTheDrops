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
  // sRGB->Lab helpers
  function srgb2lin(c){ c/=255; return (c<=0.04045)? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
  function toXYZ(r,g,b){
    const R=srgb2lin(r), G=srgb2lin(g), B=srgb2lin(b);
    const X = 0.4124564*R + 0.3575761*G + 0.1804375*B;
    const Y = 0.2126729*R + 0.7151522*G + 0.0721750*B;
    const Z = 0.0193339*R + 0.1191920*G + 0.9503041*B;
    return {X,Y,Z};
  }
  function fLab(t){ const d=6/29; return (t>Math.pow(d,3))? Math.cbrt(t) : t/(3*d*d)+4/29; }
  function toLab(r,g,b){ // D65/2°, normalized
    const {X,Y,Z}=toXYZ(r,g,b);
    const Xn=0.95047, Yn=1.00000, Zn=1.08883;
    const fx=fLab(X/Xn), fy=fLab(Y/Yn), fz=fLab(Z/Zn);
    const L = 116*fy - 16;
    const a = 500*(fx - fy);
    const b_ = 200*(fy - fz);
    return {L,a,b:b_};
  }
  function hueDistDeg(hDeg, refDeg){ let d=Math.abs(hDeg-refDeg)%360; if(d>180) d=360-d; return d; }

  // ---- Tunables ----
  const TUNE = {
    // HSV caps to kill bright plastics and keep darker blood
    vMaxBase: 0.60,    // max value for V
    vMin: 0.10,
    sMinBase: 0.55,    // min saturation
    hTolBase: 14,      // hue tolerance degrees around 0°
    // Lab gates: blood => high +a, small +b (little yellow)
    aMinBase: 35,
    bMaxBase: 22,
    aDivBRatio: 1.8,   // a / max(b,eps) >= this
    // YCbCr discrimination
    crRelBase: 90,
    yMaxBase: 185,
    // Blob heuristics
    minArea: 140,
    maxFrac: 0.15,
    edgeMagThresh: 60,
    maxEdgeDensity: 0.22,
    maxSpecDensity: 0.02,
    minSolidity: 0.80,
    maxOriDominance: 0.52,
  };

  // Scoring function: 0..1 (HSV + ratios + YCbCr + Lab)
  function bloodScore(r,g,b, sens){ // sens in [0..1]
    if (!(r > g && g >= b)) return 0;

    // HSV
    const {h,s,v}=toHSV(r,g,b);
    const hDeg=h*360;
    const hTol = TUNE.hTolBase + 10*(1-sens);
    const sMin = TUNE.sMinBase - 0.25*(1-sens);
    const vMax = TUNE.vMaxBase + 0.10*(1-sens);
    if (hueDistDeg(hDeg,0)>hTol || s<sMin || v<TUNE.vMin || v>vMax) return 0;

    // Ratios
    const r_g = r/Math.max(1,g), r_b = r/Math.max(1,b);
    if (r_g < (1.3 - 0.1*sens) || r_b < (2.0 - 0.3*sens) || (r-g)<14 || (r-b)<28) return 0;

    // YCbCr
    const {y,cb,cr}=toYCbCr(r,g,b);
    const crRel = cr - 0.55*cb;
    if (y > TUNE.yMaxBase + 25*(1-sens) || crRel < TUNE.crRelBase - 20*(1-sens)) return 0;

    // Lab
    const {a,b:b_} = toLab(r,g,b);
    const aMin = TUNE.aMinBase - 8*(1-sens);
    const bMax = TUNE.bMaxBase + 8*(1-sens);
    if (a < aMin || b_ > bMax || (a/Math.max(1e-3, b_)) < TUNE.aDivBRatio) return 0;

    // build score (weighted)
    const hueScore = Math.max(0, 1 - hueDistDeg(hDeg,0)/(hTol+1));
    const satScore = Math.min(1, (s - 0.35)/0.5);
    const valScore = Math.min(1, (0.72 - v)/0.4);
    const crCbScore = Math.min(1, (crRel - 80)/80);
    const labScore = Math.min(1, ((a - aMin)/30 + (Math.max(0,bMax - b_)/20))/2);
    const ratioScore = Math.min(1, ((r_b-1.6)/1.5 + (r_g-1.15)/0.7)/2);
    let score = 0.27*hueScore + 0.15*satScore + 0.16*valScore + 0.18*crCbScore + 0.16*labScore + 0.08*ratioScore;
    return Math.max(0, Math.min(1, score));
  }

  // ---- Image helpers ----
  function sobelMagOri(gray, w, h){
    const mag = new Float32Array(w*h);
    const ori = new Float32Array(w*h);
    const get=(x,y)=>gray[Math.max(0,Math.min(h-1,y))*w + Math.max(0,Math.min(w-1,x))];
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const gx = -get(x-1,y-1)-2*get(x-1,y)+-get(x-1,y+1) + get(x+1,y-1)+2*get(x+1,y)+get(x+1,y+1);
        const gy = -get(x-1,y-1)-2*get(x,y-1)-get(x+1,y-1) + get(x-1,y+1)+2*get(x,y+1)+get(x+1,y+1);
        const m = Math.hypot(gx,gy);
        mag[y*w+x]=m;
        ori[y*w+x]=Math.atan2(gy,gx);
      }
    }
    return {mag, ori};
  }
  function computeGray(imgData){
    const d=imgData.data, w=imgData.width, h=imgData.height;
    const g=new Float32Array(w*h);
    for(let p=0,i=0;p<d.length;p+=4,i++){ g[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2]; }
    return g;
  }

  function filterBlobs(binary, w, h, imgData){
    const visited = new Uint8Array(w*h);
    const keep = new Uint8Array(w*h);
    const px = imgData.data;

    const gray = computeGray(imgData);
    const {mag, ori} = sobelMagOri(gray, w, h);

    const minArea = TUNE.minArea;
    const maxArea = Math.floor(w*h*TUNE.maxFrac);

    const isSpecular = (r,g,b)=>{ const {h,s,v}=toHSV(r,g,b); return (v>0.85 && s<0.25); };

    function flood(start){
      const q=[start]; visited[start]=1;
      const coords=[]; let area=0, perim=0, sumV=0, edgeCount=0, specCount=0;
      const oriBins=new Float32Array(18);
      let minx=w, maxx=0, miny=h, maxy=0;
      while(q.length){
        const cur=q.pop(); coords.push(cur); area++;
        const x=cur%w, y=(cur-x)/w;
        if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y;
        const p=cur*4; const r=px[p], g=px[p+1], b=px[p+2];
        const v=Math.max(r,g,b)/255; sumV+=v;
        if(isSpecular(r,g,b)) specCount++;
        const m=mag[cur]; if(m>TUNE.edgeMagThresh) edgeCount++;
        let ang=ori[cur]; if(ang<0) ang+=Math.PI*2;
        const bin=Math.min(17, Math.floor(ang/(Math.PI*2)*18)); oriBins[bin]++;

        const neigh=[cur-1,cur+1,cur-w,cur+w];
        let boundary=false;
        for(const n of neigh){
          if(n<0||n>=w*h){ boundary=true; continue; }
          if(!binary[n]) boundary=true;
          if(!visited[n] && binary[n]){ visited[n]=1; q.push(n); }
        }
        if(boundary) perim++;
      }
      const bboxArea=(maxx-minx+1)*(maxy-miny+1);
      const solidity=area/Math.max(1,bboxArea);
      const meanV=sumV/Math.max(1,area);
      const edgeDensity=edgeCount/Math.max(1,area);
      const specDensity=specCount/Math.max(1,area);
      let maxBin=0,sumBins=0; for(let i=0;i<oriBins.length;i++){ if(oriBins[i]>maxBin)maxBin=oriBins[i]; sumBins+=oriBins[i]; }
      const oriDominance=maxBin/Math.max(1,sumBins);

      const keepBlob = (area>=minArea) && (area<=maxArea) &&
                       (meanV <= TUNE.vMaxBase+0.02) &&
                       (solidity >= TUNE.minSolidity) &&
                       (edgeDensity <= TUNE.maxEdgeDensity) &&
                       (specDensity <= TUNE.maxSpecDensity) &&
                       (oriDominance <= TUNE.maxOriDominance);
      return {keepBlob, coords};
    }

    for(let i=0;i<w*h;i++){
      if(visited[i] || !binary[i]) continue;
      const {keepBlob, coords} = flood(i);
      if(keepBlob){ for(const id of coords) keep[id]=1; }
    }
    return keep;
  }

  async function start(){
    if (stream) return;
    try{
      setMsg('Requesting camera…');
      stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' } }, audio:false });
    }catch(err){
      setMsg('Camera error: '+err.name+' — '+err.message+'\nOpen in Safari, allow camera.'); return;
    }
    el.video.srcObject = stream; try{ await el.video.play(); }catch{}
    W=el.video.videoWidth||640; H=el.video.videoHeight||480;
    const ctx=el.view.getContext('2d',{willReadFrequently:true});
    el.view.width=W; el.view.height=H;
    el.startBtn.disabled=true; el.stopBtn.disabled=false; el.snapBtn.disabled=false;
    setMsg('Streaming…');

    const tick=()=>{
      if(!stream){ cancelAnimationFrame(anim); return; }
      ctx.drawImage(el.video,0,0,W,H);
      if(el.showMask.checked || el.debugHeat.checked){
        const img=ctx.getImageData(0,0,W,H);
        const d=img.data;
        const sens=Number(el.sens.value)/100;
        const thr=Number(el.thr.value)/100;
        const score=new Float32Array(W*H);
        let min=1e9,max=-1e9;
        for(let p=0,i=0;p<d.length;p+=4,i++){
          const s=bloodScore(d[p],d[p+1],d[p+2],sens);
          score[i]=s; if(s<min)min=s; if(s>max)max=s;
        }
        const rng=Math.max(1e-6,max-min);
        const bin=new Uint8Array(W*H);
        for(let i=0;i<score.length;i++){ const n=(score[i]-min)/rng; if(n>=thr) bin[i]=1; }
        const kept=filterBlobs(bin,W,H,img);
        for(let p=0,i=0;p<d.length;p+=4,i++){
          if(el.debugHeat.checked){
            const n=(score[i]-min)/rng;
            d[p]=Math.min(255,n*255); d[p+1]=0; d[p+2]=Math.min(255,(1-n)*255); d[p+3]=255;
          }else if(kept[i]){
            d[p]=Math.max(d[p],220); d[p+1]=Math.min(d[p+1],30); d[p+2]=Math.min(d[p+2],30);
          }else{
            d[p]=(d[p]*0.88)|0; d[p+1]=(d[p+1]*0.92)|0; d[p+2]=(d[p+2]*0.95)|0;
          }
        }
        ctx.putImageData(img,0,0);
      }
      anim=requestAnimationFrame(tick);
    };
    tick();
  }
  function stop(){ if(anim) cancelAnimationFrame(anim); if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } el.startBtn.disabled=false; el.stopBtn.disabled=true; el.snapBtn.disabled=true; setMsg('Stopped.'); }
  function snapshot(){ const a=document.createElement('a'); a.download=`trackthedrop_${Date.now()}.png`; a.href=el.view.toDataURL('image/png'); a.click(); }
  if('serviceWorker'in navigator){ navigator.serviceWorker.register('./sw.js').catch(()=>{}); }
  el.startBtn.addEventListener('click', start); el.stopBtn.addEventListener('click', stop); el.snapBtn.addEventListener('click', snapshot);
  setMsg('JS loaded. Tap Start.');
})();