(function(){
  window.addEventListener('error', e=>{const m=document.getElementById('msg');if(m)m.textContent='JS error: '+(e?.message||e)});
  const qs=id=>document.getElementById(id);
  const el={video:qs('video'),overlay:qs('overlay'),tapHint:qs('tapHint'),status:qs('status'),fps:qs('fps'),
    startBtn:qs('startBtn'),stopBtn:qs('stopBtn'),snapBtn:qs('snapBtn'),clearSW:qs('clearSW'),
    thr:qs('thr'),thrVal:qs('thrVal'),sens:qs('sens'),sensVal:qs('sensVal'),stability:qs('stability'),stabVal:qs('stabVal'),
    overlayMode:qs('overlayMode'),profile:qs('profile'),opacity:qs('opacity'),opVal:qs('opVal'),msg:qs('msg'),
    fsBtn:qs('fsBtn'),torchBtn:qs('torchBtn'),vibeToggle:qs('vibeToggle'),
    dropPing:qs('dropPing'),clearPings:qs('clearPings'),trackWalk:qs('trackWalk')};
  const bindRange=(r,lab,fmt=v=>Number(v/100).toFixed(2))=>{const f=()=>lab.textContent=fmt(r.value);r.addEventListener('input',f);f()}
  bindRange(el.opacity,el.opVal);bindRange(el.thr,el.thrVal);bindRange(el.sens,el.sensVal);bindRange(el.stability,el.stabVal,v=>String(v));

  let stream=null, anim=null, lastTS=0, frames=0;
  let dispW=640, dispH=480, procW=320, procH=240, frameCount=0;
  let persist=null, stableMask=null, edgesCache=null;
  let torchOn=false;

  const BASE={vMaxBase:0.58,vMin:0.08,sMinBase:0.58,hTolBase:14,aMinBase:38,bMaxBase:20,aDivBRatio:2.0,crRelBase:95,yMaxBase:182,
    minAreaFrac:0.0007,maxFrac:0.14,edgeMagThresh:65,maxEdgeDensity:0.22,maxSpecDensity:0.02,minSolidity:0.80,maxOriDominance:0.50};
  const PROFILES={balanced:{...BASE},safety:{...BASE,vMaxBase:0.55,sMinBase:0.60,hTolBase:12,aMinBase:40,bMaxBase:18,aDivBRatio:2.1,crRelBase:100,yMaxBase:175,maxFrac:0.12,edgeMagThresh:70,maxEdgeDensity:0.20,maxSpecDensity:0.015,minSolidity:0.82,maxOriDominance:0.48},
    aggressive:{...BASE,vMaxBase:0.66,sMinBase:0.52,aMinBase:34,bMaxBase:24,crRelBase:88,yMaxBase:190,maxFrac:0.18,edgeMagThresh:58,maxEdgeDensity:0.26,maxSpecDensity:0.03,minSolidity:0.78,maxOriDominance:0.56}};
  const getTune=()=>PROFILES[el.profile.value||'aggressive'];

  function toHSV(r,g,b){const rn=r/255,gn=g/255,bn=b/255;const max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min;let h=0;if(d!==0){if(max===rn)h=((gn-bn)/d+(gn<bn?6:0));else if(max===gn)h=((bn-rn)/d+2);else h=((rn-gn)/d+4);h/=6}const s=max===0?0:d/max,v=max;return {h,s,v}}
  function toYCbCr(r,g,b){const y=0.299*r+0.587*g+0.114*b;const cb=128-0.168736*r-0.331264*g+0.5*b;const cr=128+0.5*r-0.418688*g-0.081312*b;return {y,cb,cr}}
  function srgb2lin(c){c/=255;return(c<=0.04045)?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
  function toLab(r,g,b){const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);const X=0.4124564*R+0.3575761*G+0.1804375*B;const Y=0.2126729*R+0.7151522*G+0.0721750*B;const Z=0.0193339*R+0.1191920*G+0.9503041*B;const Xn=0.95047,Yn=1.0,Zn=1.08883;const f=t=>{const d=6/29;return(t>Math.pow(d,3))?Math.cbrt(t):t/(3*d*d)+4/29};const fx=f(X/Xn),fy=f(Y/Yn),fz=f(Z/Zn);return {L:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)}}
  const hueDistDeg=(hDeg,ref)=>{let d=Math.abs(hDeg-ref)%360;if(d>180)d=360-d;return d}

  const proc=document.createElement('canvas'), pctx=proc.getContext('2d',{willReadFrequently:true});

  function scorePixel(r,g,b,sens,tune,doLab){
    if(!(r>g&&g>=b))return 0;
    const {h,s,v}=toHSV(r,g,b);const hDeg=h*360,hTol=tune.hTolBase+10*(1-sens);const sMin=tune.sMinBase-0.25*(1-sens);const vMax=tune.vMaxBase+0.10*(1-sens);
    if(hueDistDeg(hDeg,0)>hTol||s<sMin||v<tune.vMin||v>vMax)return 0;
    const r_g=r/Math.max(1,g),r_b=r/Math.max(1,b);if(r_g<(1.28-0.1*sens)||r_b<(1.9-0.3*sens)||(r-g)<12||(r-b)<26)return 0;
    const {y,cb,cr}=toYCbCr(r,g,b);const crRel=cr-0.55*cb;if(y>getTune().yMaxBase+25*(1-sens)||crRel<getTune().crRelBase-20*(1-sens))return 0;
    if(doLab){const {L,a,b:bb}=toLab(r,g,b);const aMin=getTune().aMinBase-8*(1-sens);const bMax=getTune().bMaxBase+8*(1-sens);
      if(a<aMin||bb>bMax||(a/Math.max(1e-3,bb))<getTune().aDivBRatio||L>64)return 0;}
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

  function filterBlobs(binary,w,h,img,tune,edges){
    const visited=new Uint8Array(w*h),keep=new Uint8Array(w*h),px=img.data,mag=edges.mag,ori=edges.ori;
    const minArea=Math.max(8,Math.floor(w*h*getTune().minAreaFrac)),maxArea=Math.floor(w*h*tune.maxFrac);
    const isSpecular=(r,g,b)=>{const {h,s,v}=toHSV(r,g,b);return(v>0.85&&s<0.25)};
    function flood(start){
      const q=[start];visited[start]=1;const coords=[];let area=0;const oriBins=new Float32Array(12);
      let minx=w,maxx=0,miny=h,maxy=0;
      while(q.length){const cur=q.pop();coords.push(cur);const x=cur%w,y=(cur-x)/w;
        if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;
        const p=cur*4,r=px[p],g=px[p+1],b=px[p+2];
        if(mag[cur]>getTune().edgeMagThresh){}
        let ang=ori[cur];if(ang<0)ang+=Math.PI*2;const bin=Math.min(11,Math.floor(ang/(Math.PI*2)*12));oriBins[bin]++;
        const neigh=[cur-1,cur+1,cur-w,cur+w];
        for(const n of neigh){if(n<0||n>=w*h)continue;if(!visited[n]&&binary[n]){visited[n]=1;q.push(n)}}
      }
      const bboxArea=(maxx-minx+1)*(maxy-miny+1);const areaCount=coords.length;const solidity=areaCount/Math.max(1,bboxArea);
      let maxBin=0,sumBins=0;for(let i=0;i<12;i++){if(oriBins[i]>maxBin)maxBin=oriBins[i];sumBins+=oriBins[i]}const oriDominance=maxBin/Math.max(1,sumBins);
      const ok=(areaCount>=minArea)&&(areaCount<=maxArea)&&(solidity>=getTune().minSolidity)&&(oriDominance<=getTune().maxOriDominance);
      return {ok,coords}
    }
    for(let i=0;i<w*h;i++){if(visited[i]||!binary[i])continue;const {ok,coords}=flood(i);if(ok)for(const id of coords)keep[id]=1}
    return keep
  }

  const hitCircles=[];
  function addHitCircle(cx,cy){hitCircles.push({x:cx,y:cy,ts:performance.now()}); if(hitCircles.length>80)hitCircles.shift()}
  function drawHitCircles(ctx){
    const now=performance.now();
    for(const c of hitCircles){
      const age=(now-c.ts)/1000; if(age>6) continue;
      const a=Math.max(0,1-age/6); ctx.save(); ctx.globalAlpha=a; ctx.strokeStyle='rgba(239,68,68,1)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(c.x,c.y,16,0,Math.PI*2); ctx.stroke(); ctx.restore();
    }
  }

  let map, gpsWatch=null, routeLine=null, routePts=[], pingMarkers=[];
  function initMap(){
    map=L.map('map',{zoomControl:true}); 
    try{
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{maxZoom:17,attribution:'Map: © OpenTopoMap, © OpenStreetMap contributors'}).addTo(map);
    }catch{ 
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
    }
    map.setView([38.0,-90.0],12);
    routeLine=L.polyline([], {color:'#22c55e', weight:3}).addTo(map);
    const saved=localStorage.getItem('ttd_pings'); if(saved){for(const p of JSON.parse(saved)){addPing(p.lat,p.lng)}}
    const savedRoute=localStorage.getItem('ttd_route'); if(savedRoute){routePts=JSON.parse(savedRoute);routeLine.setLatLngs(routePts)}
  }
  function addPing(lat,lng){const m=L.marker([lat,lng]).addTo(map); m.bindPopup('Ping'); pingMarkers.push(m);
    localStorage.setItem('ttd_pings', JSON.stringify(pingMarkers.map(pm=>pm.getLatLng())));}
  function clearPings(){for(const pm of pingMarkers){map.removeLayer(pm)} pingMarkers.length=0; localStorage.removeItem('ttd_pings')}
  function startGPS(){
    if(!navigator.geolocation) return;
    if(gpsWatch) return;
    gpsWatch=navigator.geolocation.watchPosition(pos=>{
      const {latitude:lat,longitude:lng}=pos.coords;
      if(routePts.length===0) map.setView([lat,lng],15);
      routePts.push([lat,lng]); routeLine.setLatLngs(routePts);
      localStorage.setItem('ttd_route', JSON.stringify(routePts));
    },err=>{console.log('gps err',err)},{enableHighAccuracy:true, maximumAge:2000, timeout:7000});
  }
  function stopGPS(){if(gpsWatch){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null}}

  async function toggleTorch(){
    if(!stream) return;
    try{
      const tracks=stream.getVideoTracks(); if(!tracks.length) return;
      const t=tracks[0]; const cap=t.getCapabilities?.(); 
      if(cap && 'torch' in cap){ await t.applyConstraints({advanced:[{torch: !torchOn}]}); torchOn=!torchOn; document.getElementById('torchBtn').textContent=torchOn?'Flashlight: On':'Flashlight'; return; }
    }catch(e){console.log('torch error',e)}
    document.body.style.background='#fff'; setTimeout(()=>{document.body.style.background='var(--bg)'}, 10000);
  }

  document.getElementById('fsBtn').addEventListener('click',()=>{
    const vp=document.getElementById('viewport');
    if(document.fullscreenElement){document.exitFullscreen()}
    else{vp.requestFullscreen?.()}
  });
  document.getElementById('torchBtn').addEventListener('click',toggleTorch);
  document.getElementById('dropPing').addEventListener('click',()=>{if(map){const c=map.getCenter(); addPing(c.lat,c.lng)}});
  document.getElementById('clearPings').addEventListener('click',clearPings);
  document.getElementById('trackWalk').addEventListener('change',e=>{if(e.target.checked) startGPS(); else stopGPS()});

  function vibrate(ms){ try{ if(document.getElementById('vibeToggle').checked && navigator.vibrate) navigator.vibrate(ms||50) }catch{} }

  async function start(){
    if(stream) return;
    try{
      document.getElementById('status').textContent='Requesting camera…';
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false});
    }catch(e){document.getElementById('msg').textContent='Camera error: '+e.message;return}
    el.video.srcObject=stream; try{await el.video.play()}catch{}
    dispW=el.video.videoWidth||640; dispH=el.video.videoHeight||480;
    el.overlay.width=dispW; el.overlay.height=dispH;
    const scale=320/dispW; procW=Math.max(160,Math.round(dispW*scale)); procH=Math.max(120,Math.round(dispH*scale));
    proc.width=procW; proc.height=procH;
    el.startBtn.disabled=true; el.stopBtn.disabled=false; el.snapBtn.disabled=false; el.tapHint.style.display='none'; el.status.textContent='Streaming…';
    if(document.getElementById('trackWalk').checked) startGPS();

    const ox=el.overlay.getContext('2d');

    function frame(ts){
      if(!stream){cancelAnimationFrame(anim);return}
      frames++; if(ts-lastTS>1000){el.fps.textContent=frames+' fps'; frames=0; lastTS=ts}
      frameCount++;

      pctx.drawImage(el.video,0,0,procW,procH);
      const color=pctx.getImageData(0,0,procW,procH);
      const d=color.data, sens=Number(el.sens.value)/100, thr=Number(el.thr.value)/100, tune=getTune();
      const doLab = (!document.getElementById('fastMode').checked) || (frameCount%2===0);

      const score=new Float32Array(procW*procH); let max=-1e9, min=1e9;
      for(let p=0,i=0;p<d.length;p+=4,i++){const s=scorePixel(d[p],d[p+1],d[p+2],sens,tune,doLab); score[i]=s; if(s>max)max=s; if(s<min)min=s;}
      const rng=Math.max(1e-6,max-min);
      const bin=new Uint8Array(procW*procH); for(let i=0;i<score.length;i++){const n=(score[i]-min)/rng; if(n>=thr) bin[i]=1;}
      if(frameCount%3===1 || !edgesCache){
        const gray=new Float32Array(procW*procH);
        for(let p=0,i=0;p<d.length;p+=4,i++){gray[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2]}
        edgesCache=sobel(gray,procW,procH);
      }
      const kept=filterBlobs(bin,procW,procH,color,tune,edgesCache);

      if(!persist){persist=new Uint8Array(procW*procH);stableMask=new Uint8Array(procW*procH)}
      const need=Number(el.stability.value);
      let hitThisFrame=false; let cxSum=0, cySum=0, cCount=0;
      for(let i=0;i<kept.length;i++){
        if(kept[i]) persist[i]=Math.min(255,persist[i]+1); else persist[i]=Math.max(0,persist[i]-1); 
        stableMask[i]=persist[i]>=need?1:0; 
        if(stableMask[i]){ hitThisFrame=true; const x=i%procW, y=(i-x)/procW; cxSum+=x; cySum+=y; cCount++; }
      }
      if(hitThisFrame && cCount>20){
        const cx=(cxSum/cCount)*dispW/procW, cy=(cySum/cCount)*dispH/procH;
        addHitCircle(cx,cy); vibrate(30);
      }

      ox.clearRect(0,0,dispW,dispH);
      const mode=el.overlayMode.value, alpha=Number(el.opacity.value)/100;
      if(mode==='debug'){
        const heat=pctx.createImageData(procW,procH), dd=heat.data;
        for(let i=0,p=0;i<score.length;i++,p+=4){const n=(score[i]-min)/rng; dd[p]=Math.min(255,n*255); dd[p+1]=0; dd[p+2]=Math.min(255,(1-n)*255); dd[p+3]=255}
        pctx.putImageData(heat,0,0); el.overlay.getContext('2d').drawImage(proc,0,0,dispW,dispH);
      }else{
        const out=pctx.createImageData(procW,procH), od=out.data;
        for(let i=0,p=0;i<stableMask.length;i++,p+=4){ if(stableMask[i]){ od[p]=235;od[p+1]=20;od[p+2]=20;od[p+3]=Math.floor(alpha*255);} }
        pctx.putImageData(out,0,0); el.overlay.getContext('2d').drawImage(proc,0,0,dispW,dispH);
      }
      drawHitCircles(el.overlay.getContext('2d'));
      anim=requestAnimationFrame(frame);
    }
    anim=requestAnimationFrame(frame);
  }

  function stop(){ if(anim)cancelAnimationFrame(anim); if(stream){stream.getTracks().forEach(t=>t.stop());stream=null} 
    el.startBtn.disabled=false; el.stopBtn.disabled=true; el.snapBtn.disabled=true; el.tapHint.style.display=''; el.status.textContent='Stopped.'; 
    if(window.navigator && navigator.geolocation) { /* stop gps */ } }

  function snapshot(){ const a=document.createElement('a'); a.download=`ttd_${Date.now()}.png`; a.href=el.overlay.toDataURL('image/png'); a.click(); }

  if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{})}
  let deferredPrompt=null; window.addEventListener('beforeinstallprompt',e=>{e.preventDefault(); deferredPrompt=e; document.getElementById('installBtn').style.display='inline-flex'});
  document.getElementById('installBtn').onclick=()=>{ if(deferredPrompt){deferredPrompt.prompt(); deferredPrompt=null} }
  el.clearSW.onclick=async()=>{ if('caches' in window){ const keys=await caches.keys(); await Promise.all(keys.map(k=>caches.delete(k))); location.reload(); } }

  window.addEventListener('load', initMap);
  document.getElementById('viewport').addEventListener('click',()=>{ if(!stream) start() });
  el.startBtn.addEventListener('click',start); el.stopBtn.addEventListener('click',stop); el.snapBtn.addEventListener('click',snapshot);

  el.msg.textContent='JS loaded. Ready.';
})();