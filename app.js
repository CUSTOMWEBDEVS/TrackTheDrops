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
  function hueDistDeg(hDeg, refDeg){
    let d = Math.abs(hDeg - refDeg) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  // Scoring function: 0..1 (HSV + ratios + YCbCr)
  function bloodScore(r,g,b, sensGate){
    if (!(r > g && g >= b)) return 0;

    const {h,s,v} = toHSV(r,g,b);
    const hDeg = h*360;
    const hTol = 14 + 10*(1-sensGate);
    const hueOK = (hueDistDeg(hDeg, 0) <= hTol);
    const sMin  = 0.55 - 0.25*(1-sensGate);
    const sOK = s >= sMin;
    const vMax = 0.62 + 0.10*(1-sensGate);
    const vMin = 0.10;
    const vOK = v >= vMin && v <= vMax;
    if (!(hueOK && sOK && vOK)) return 0;

    const r_g = r/Math.max(1,g);
    const r_b = r/Math.max(1,b);
    const gapRG = r-g, gapRB = r-b;
    const ratioOK = (r_g >= 1.3 - 0.1*sensGate) && (r_b >= 2.0 - 0.3*sensGate) && (gapRG >= 14) && (gapRB >= 28);
    if (!ratioOK) return 0;

    const {y,cb,cr} = toYCbCr(r,g,b);
    const yOK  = y <= 185 + 25*(1-sensGate);
    const crOK = cr >= 160 - 20*(1-sensGate);
    const crRel = (cr - 0.55*cb);
    const crRelOK = crRel >= 90 - 20*(1-sensGate);
    if (!(yOK && crOK && crRelOK)) return 0;

    // score
    const hueScore = Math.max(0, 1 - hueDistDeg(hDeg, 0) / (hTol+1));
    const satScore = Math.min(1, (s - 0.35)/0.5);
    const valScore = Math.min(1, (0.75 - v)/0.4);
    const crCbScore = Math.min(1, (crRel - 80)/80);
    const ratioScore = Math.min(1, ((r_b-1.6)/1.5 + (r_g-1.15)/0.7)/2);

    let score = 0;
    score += 0.30*hueScore;
    score += 0.18*satScore;
    score += 0.18*valScore;
    score += 0.22*crCbScore;
    score += 0.12*ratioScore;
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
        ori[y*w+x]=Math.atan2(gy,gx); // -pi..pi
      }
    }
    return {mag, ori};
  }

  function computeGray(imgData){
    const d=imgData.data, w=imgData.width, h=imgData.height;
    const g=new Float32Array(w*h);
    for(let p=0,i=0;p<d.length;p+=4,i++){
      g[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];
    }
    return g;
  }

  // Blob filter: rejects leaves/wood using geometry+texture cues
  function filterBlobs(binary, w, h, imgData){
    const visited = new Uint8Array(w*h);
    const keep = new Uint8Array(w*h);
    const px = imgData.data;

    const gray = computeGray(imgData);
    const {mag, ori} = sobelMagOri(gray, w, h);

    const minArea = 150;
    const maxFrac = 0.15; // 15% of frame
    const maxArea = Math.floor(w*h*maxFrac);

    const isSpecular = (r,g,b)=>{
      const {h,s,v}=toHSV(r,g,b);
      return (v>0.85 && s<0.25);
    };

    function flood(start){
      const q=[start]; visited[start]=1;
      const coords=[]; let area=0, perim=0, sumV=0, edgeCount=0, specCount=0;
      const oriBins=new Float32Array(18); // 10° bins
      while(q.length){
        const cur=q.pop(); coords.push(cur); area++;
        const x=cur%w, y=(cur-x)/w;
        const p=cur*4;
        const r=px[p], g=px[p+1], b=px[p+2];
        const v=Math.max(r,g,b)/255; sumV+=v;
        if(isSpecular(r,g,b)) specCount++;

        const m=mag[cur]; if(m>60) edgeCount++; // edge magnitude threshold
        let ang=ori[cur]; if(ang<0) ang+=Math.PI*2;
        const bin=Math.min(17, Math.floor(ang/(Math.PI*2)*18)); oriBins[bin]++;

        // boundary check for perimeter (4-neigh)
        const neigh=[cur-1,cur+1,cur-w,cur+w];
        let localBoundary=false;
        for(const n of neigh){
          if(n<0||n>=w*h){ localBoundary=true; continue; }
          if(!binary[n]) localBoundary=true;
          if(!visited[n] && binary[n]){ visited[n]=1; q.push(n); }
        }
        if(localBoundary) perim++;
      }
      // geometry
      // approximate solidity using bounding box vs area (fast proxy)
      let minx=w, maxx=0, miny=h, maxy=0;
      for(const id of coords){ const x=id%w, y=(id-x)/w; if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y; }
      const bboxArea=(maxx-minx+1)*(maxy-miny+1);
      const solidity=area/Math.max(1,bboxArea);

      const meanV=sumV/Math.max(1,area);
      const edgeDensity=edgeCount/Math.max(1,area);
      const specDensity=specCount/Math.max(1,area);

      // wood grain: strong single orientation
      let maxBin=0,sumBins=0;
      for(let i=0;i<oriBins.length;i++){ if(oriBins[i]>maxBin)maxBin=oriBins[i]; sumBins+=oriBins[i]; }
      const oriDominance = maxBin/Math.max(1,sumBins); // close to 1 => single direction

      // Heuristics:
      // - keep darker, fairly solid blobs
      // - drop very bright mean (dew/candy), jagged (high edge density), or strong single orientation (wood)
      const areaOK = (area>=minArea) && (area<=maxArea);
      const brightnessOK = meanV <= 0.62;
      const solidityOK = solidity >= 0.80;   // leaves with lobes tend to reduce this proxy
      const jaggedOK   = edgeDensity <= 0.22; // leaves have vein edges -> higher
      const dewOK      = specDensity <= 0.02; // many tiny highlights => dew on leaf
      const woodOK     = oriDominance <= 0.52; // wood has pronounced grain orientation

      const ok = areaOK && brightnessOK && solidityOK && jaggedOK && dewOK && woodOK;
      return {ok, coords};
    }

    for(let i=0;i<w*h;i++){
      if(visited[i] || !binary[i]) continue;
      const {ok, coords} = flood(i);
      if(ok){ for(const id of coords) keep[id]=1; }
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