(() => {
"use strict";

const V = document.getElementById('vid');
const C = document.getElementById('hud');
const ctx = C.getContext('2d');
const gate = document.getElementById('gate');
const errBox = document.getElementById('err');
const bar = document.getElementById('bar');
const flash = document.getElementById('flash');

const CY = '#6fe6ff', AM = '#ffb13b', RD = '#ff4f45';
const BOOT = 2.4;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const MP_CDN   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let W = 0, H = 0, DPR = 1;
const S = {
  running:false, bootT:0, t:0, facing:'user', sound:true, grade:true,
  stream:null, tracks:[], nextId:1, fps:60, heading:0, headingLive:false,
  battery:null, shake:0,
  faceState:'idle', faceMsg:''
};

const clamp = (v,a,b)=>v<a?a:(v>b?b:v);
const lerp  = (a,b,k)=>a+(b-a)*k;
const easeOut = t => 1-Math.pow(1-t,3);
const pad = (n,l=2)=>String(Math.floor(n)).padStart(l,'0');
const FF = getComputedStyle(document.body).fontFamily || 'monospace';
function font(px,w=500){ ctx.font = w+' '+px+'px '+FF; }

/* ================= audio ================= */
let AC = null;
function tone(freq, dur, type='sine', vol=0.05, slideTo=null){
  if(!S.sound) return;
  try{
    AC = AC || new (window.AudioContext||window.webkitAudioContext)();
    if(AC.state === 'suspended') AC.resume();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = freq;
    const t = AC.currentTime;
    if(slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t+dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t); o.stop(t+dur+0.03);
  }catch(e){}
}
function bootSound(){
  tone(180, 0.9, 'sawtooth', 0.03, 720);
  setTimeout(()=>tone(880,0.08,'square',0.028), 900);
  setTimeout(()=>tone(1320,0.08,'square',0.028), 1030);
  setTimeout(()=>tone(1760,0.16,'sine',0.035), 1160);
}

/* ================= sizing ================= */
function resize(){
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  C.width = Math.round(W*DPR); C.height = Math.round(H*DPR);
  C.style.width = W+'px'; C.style.height = H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
}
addEventListener('resize', resize);
addEventListener('orientationchange', ()=>setTimeout(resize,200));
resize();

/* ================= camera ================= */
async function openCamera(){
  if(S.stream) S.stream.getTracks().forEach(t=>t.stop());
  S.stream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:{ideal:S.facing}, width:{ideal:1280}, height:{ideal:720} },
    audio:false
  });
  V.srcObject = S.stream;
  await V.play();
  prevGray = null;
  S.tracks.length = 0;
  faces.length = 0;
  lastVideoTime = -1;
}

async function start(){
  errBox.classList.remove('on');
  try{
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('このブラウザはカメラに対応していません。');
    await openCamera();
  }catch(e){
    errBox.textContent = 'カメラを開けません。' +
      (location.protocol === 'https:' ? '' : ' このページが安全な接続（HTTPS）で開かれていません。') +
      ' 埋め込み枠（iframe）内ではカメラが遮断されます。ページを直接開き、ブラウザの権限を「許可」にしてお試しください。（' + (e.name||e.message) + '）';
    errBox.classList.add('on');
    return;
  }
  askCompass();
  loadFaceLandmarker();
  gate.classList.add('gone');
  bar.classList.add('on');
  S.running = true; S.bootT = 0;
  bootSound();
}

function stop(){
  S.running = false;
  if(S.stream){ S.stream.getTracks().forEach(t=>t.stop()); S.stream = null; }
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,W,H);
  bar.classList.remove('on');
  gate.classList.remove('gone');
}

/* ================= compass ================= */
function askCompass(){
  const attach = () => {
    addEventListener('deviceorientationabsolute', onOri, true);
    addEventListener('deviceorientation', onOri, true);
  };
  const D = window.DeviceOrientationEvent;
  if(D && typeof D.requestPermission === 'function'){
    D.requestPermission().then(r=>{ if(r === 'granted') attach(); }).catch(()=>{});
  } else attach();
}
function onOri(e){
  let h = null;
  if(typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if(typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
  if(h === null || isNaN(h)) return;
  S.headingLive = true;
  let d = h - S.heading;
  while(d > 180) d -= 360;
  while(d < -180) d += 360;
  S.heading = (S.heading + d*0.18 + 360) % 360;
}

/* ================= 顔認識（MediaPipe Face Landmarker） ================= */
let FL = null, CONN = null;
let faces = [];
let lastVideoTime = -1;
let faceSeq = 0;

async function loadFaceLandmarker(){
  if(S.faceState === 'loading' || S.faceState === 'ready') return;
  S.faceState = 'loading';
  try{
    const vision = await import(MP_CDN);
    const { FaceLandmarker, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(MP_CDN + '/wasm');
    const opts = (delegate) => ({
      baseOptions:{ modelAssetPath: MP_MODEL, delegate },
      runningMode:'VIDEO', numFaces:3
    });
    try{
      FL = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
    }catch(e){
      FL = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
    }
    CONN = {
      oval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
      lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
      eyeL: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
      eyeR: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
      browL: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
      browR: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
      irisL: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
      irisR: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
      tess: FaceLandmarker.FACE_LANDMARKS_TESSELATION
    };
    S.faceState = 'ready';
    tone(1600, 0.09, 'sine', 0.03);
  }catch(e){
    S.faceState = 'error';
    S.faceMsg = (e && (e.message||e.name)) || String(e);
  }
}

function detectFaces(nowMs){
  if(S.faceState !== 'ready' || !FL || !V.videoWidth || V.readyState < 2) return;
  if(V.currentTime === lastVideoTime) return;
  lastVideoTime = V.currentTime;
  let res;
  try{ res = FL.detectForVideo(V, nowMs); }catch(e){ return; }
  const list = (res && res.faceLandmarks) || [];
  const out = [];
  for(const lm of list){
    let minx=1, maxx=0, miny=1, maxy=0;
    for(let i=0;i<lm.length;i++){
      const p = lm[i];
      if(p.x<minx)minx=p.x; if(p.x>maxx)maxx=p.x;
      if(p.y<miny)miny=p.y; if(p.y>maxy)maxy=p.y;
    }
    out.push({ lm, minx, maxx, miny, maxy });
  }
  for(const f of out){
    const cx = (f.minx+f.maxx)/2, cy = (f.miny+f.maxy)/2;
    let best=null, bd=1e9;
    for(const p of faces){
      if(p.taken) continue;
      const d = Math.hypot((p.minx+p.maxx)/2-cx, (p.miny+p.maxy)/2-cy);
      if(d<bd){ bd=d; best=p; }
    }
    if(best && bd < 0.18){ f.id = best.id; f.since = best.since; best.taken = true; }
    else { f.id = ++faceSeq; f.since = performance.now(); tone(1480,0.06,'square',0.026); }
  }
  faces = out;
}

/* ================= 動体検知（顔が無いときの補助） ================= */
const PW = 84, PH = 63;
const pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
const pctx = pc.getContext('2d', {willReadFrequently:true});
let prevGray = null;
const labels = new Int16Array(PW*PH);
const stack = new Int32Array(PW*PH);

function detectMotion(){
  if(!V.videoWidth || V.readyState < 2) return [];
  pctx.drawImage(V, 0, 0, PW, PH);
  let d;
  try{ d = pctx.getImageData(0,0,PW,PH).data; }catch(e){ return []; }
  const n = PW*PH;
  const g = new Uint8Array(n);
  for(let i=0, p=0; i<n; i++, p+=4) g[i] = (d[p]*77 + d[p+1]*150 + d[p+2]*29) >> 8;
  if(!prevGray){ prevGray = g; return []; }

  let moved = 0;
  const mask = new Uint8Array(n);
  for(let i=0;i<n;i++){
    if(Math.abs(g[i]-prevGray[i]) > 24){ mask[i] = 1; moved++; }
  }
  prevGray = g;
  S.shake = moved / n;
  if(S.shake > 0.5) return [];

  labels.fill(0);
  const blobs = [];
  for(let i=0;i<n;i++){
    if(!mask[i] || labels[i]) continue;
    let sp = 0; stack[sp++] = i; labels[i] = 1;
    let minx = PW, maxx = 0, miny = PH, maxy = 0, area = 0;
    while(sp > 0){
      const c = stack[--sp];
      const x = c % PW, y = (c / PW) | 0;
      area++;
      if(x<minx)minx=x; if(x>maxx)maxx=x;
      if(y<miny)miny=y; if(y>maxy)maxy=y;
      for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
        const nx = x+dx, ny = y+dy;
        if(nx<0||ny<0||nx>=PW||ny>=PH) continue;
        const ni = ny*PW+nx;
        if(mask[ni] && !labels[ni]){ labels[ni] = 1; stack[sp++] = ni; }
      }
    }
    if(area < 14) continue;
    blobs.push({
      nx:(minx+maxx+1)/2/PW, ny:(miny+maxy+1)/2/PH,
      nw:Math.max(0.07,(maxx-minx+1)/PW), nh:Math.max(0.09,(maxy-miny+1)/PH),
      area
    });
  }
  blobs.sort((a,b)=>b.area-a.area);
  return blobs.slice(0,3);
}

function updateTracks(blobs, dt){
  for(const t of S.tracks) t.hit = false;
  for(const b of blobs){
    const px = sx(b.nx), py = sy(b.ny);
    let best = null, bd = 1e9;
    for(const t of S.tracks){
      if(t.hit) continue;
      const d = Math.hypot(t.tx-px, t.ty-py);
      if(d < bd){ bd = d; best = t; }
    }
    const bw = b.nw*VR.w, bh = b.nh*VR.h;
    if(best && bd < Math.max(W,H)*0.2){
      best.tx = px; best.ty = py;
      best.tw = Math.max(best.tw*0.75, bw); best.th = Math.max(best.th*0.75, bh);
      best.hit = true; best.life = 1;
    }else{
      S.tracks.push({ id:S.nextId++, x:px, y:py, w:bw, h:bh,
        tx:px, ty:py, tw:bw, th:bh, life:1, age:0, hit:true, locked:false });
    }
  }
  const k = clamp(dt*9, 0, 1);
  for(const t of S.tracks){
    if(!t.hit) t.life -= dt/0.75;
    t.age += dt;
    t.x = lerp(t.x, t.tx, k); t.y = lerp(t.y, t.ty, k);
    t.w = lerp(t.w, t.tw, k*0.7); t.h = lerp(t.h, t.th, k*0.7);
    if(!t.locked && t.age > 0.32) t.locked = true;
  }
  S.tracks = S.tracks.filter(t=>t.life > 0);
  if(S.tracks.length > 3){
    S.tracks.sort((a,b)=>(b.w*b.h)-(a.w*a.h));
    S.tracks.length = 3;
  }
}

/* ================= 座標変換 ================= */
let VR = { x:0, y:0, w:1, h:1 };
const mirrored = () => S.facing === 'user';
function updateVideoRect(){
  const vw = V.videoWidth || 16, vh = V.videoHeight || 9;
  const s = Math.max(W/vw, H/vh);
  VR.w = vw*s; VR.h = vh*s;
  VR.x = (W-VR.w)/2; VR.y = (H-VR.h)/2;
}
function sx(nx){ return VR.x + (mirrored() ? 1-nx : nx)*VR.w; }
function sy(ny){ return VR.y + ny*VR.h; }

/* ================= 描画：映像とバイザー ================= */
function drawVideo(){
  ctx.save();
  if(mirrored()){ ctx.translate(W,0); ctx.scale(-1,1); }
  try{ ctx.drawImage(V, VR.x, VR.y, VR.w, VR.h); }catch(e){}
  ctx.restore();
  if(!S.grade) return;
  ctx.fillStyle = 'rgba(4,26,40,.08)';
  ctx.fillRect(0,0,W,H);
  const vg = ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.5, W/2,H/2,Math.max(W,H)*0.78);
  vg.addColorStop(0,'rgba(0,0,0,0)');
  vg.addColorStop(1,'rgba(0,8,14,.34)');
  ctx.fillStyle = vg; ctx.fillRect(0,0,W,H);
}

function drawScan(){
  if(!S.grade) return;
  ctx.save();
  ctx.globalAlpha = 0.03; ctx.fillStyle = CY;
  for(let y = (S.t*46)%4; y < H; y += 4) ctx.fillRect(0, y, W, 1);
  ctx.globalAlpha = 0.05;
  const syy = (S.t*0.34 % 1.6 - 0.3) * H;
  const g = ctx.createLinearGradient(0, syy-90, 0, syy+90);
  g.addColorStop(0,'rgba(111,230,255,0)');
  g.addColorStop(.5,'rgba(111,230,255,1)');
  g.addColorStop(1,'rgba(111,230,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, syy-90, W, 180);
  ctx.restore();
}

// ※ beginPath は呼び出し側で行う（矩形との複合パスを作るため）
function visorPath(inset, chamfer){
  const l = inset, r = W-inset, t = inset, b = H-inset, c = chamfer;
  ctx.moveTo(l+c, t); ctx.lineTo(r-c, t); ctx.lineTo(r, t+c);
  ctx.lineTo(r, b-c); ctx.lineTo(r-c, b); ctx.lineTo(l+c, b);
  ctx.lineTo(l, b-c); ctx.lineTo(l, t+c); ctx.closePath();
}
function drawVisor(e){
  const inset = Math.max(5, Math.min(W,H)*0.012);
  const ch = Math.min(W,H)*0.085;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0,0,W,H);
  visorPath(inset, ch);
  ctx.fillStyle = 'rgba(2,7,11,.9)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = e;
  ctx.strokeStyle = 'rgba(111,230,255,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); visorPath(inset, ch); ctx.stroke();
  ctx.strokeStyle = 'rgba(111,230,255,.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); visorPath(inset+6, ch-4); ctx.stroke();
  ctx.restore();
}

/* ================= 描画：顔 ================= */
function strokeConn(lm, conns, step){
  if(!conns) return;
  ctx.beginPath();
  for(let i=0;i<conns.length;i+=step){
    const c = conns[i];
    const a = lm[c.start], b = lm[c.end];
    if(!a || !b) continue;
    ctx.moveTo(sx(a.x), sy(a.y));
    ctx.lineTo(sx(b.x), sy(b.y));
  }
  ctx.stroke();
}

function faceMetrics(f){
  const lm = f.lm;
  const nose = lm[1], cl = lm[234], cr = lm[454];
  let yaw = 0;
  if(nose && cl && cr){
    const span = cr.x - cl.x;
    if(Math.abs(span) > 1e-4) yaw = ((nose.x - (cl.x+cr.x)/2) / span) * 2 * 55;
  }
  if(mirrored()) yaw = -yaw;
  const wN = f.maxx - f.minx;
  const dist = clamp(0.16 / Math.max(wN,0.02) * 1.15, 0.25, 12);
  return { yaw, dist };
}

function drawFaces(e){
  if(!faces.length) return;
  const now = performance.now();
  ctx.save();
  for(const f of faces){
    const lm = f.lm;
    const x0 = Math.min(sx(f.minx), sx(f.maxx)), x1 = Math.max(sx(f.minx), sx(f.maxx));
    const y0 = sy(f.miny), y1 = sy(f.maxy);
    const fw = x1-x0, fh = y1-y0;
    const cx = (x0+x1)/2, cy = (y0+y1)/2;
    const age = (now - f.since)/1000;
    const acq = clamp(age/0.5, 0, 1);
    const locked = age > 0.5;
    const col = locked ? AM : CY;
    const a = e;

    // 1) 顔メッシュ（間引いたテセレーション）
    ctx.globalAlpha = a*0.13*acq;
    ctx.strokeStyle = CY; ctx.lineWidth = 0.6;
    strokeConn(lm, CONN && CONN.tess, 6);

    // 2) 輪郭線
    ctx.globalAlpha = a*0.85*acq;
    ctx.strokeStyle = CY; ctx.lineWidth = 1.2;
    strokeConn(lm, CONN && CONN.oval, 1);
    ctx.lineWidth = 1;
    strokeConn(lm, CONN && CONN.eyeL, 1);
    strokeConn(lm, CONN && CONN.eyeR, 1);
    strokeConn(lm, CONN && CONN.browL, 1);
    strokeConn(lm, CONN && CONN.browR, 1);
    strokeConn(lm, CONN && CONN.lips, 1);

    // 3) 虹彩＋瞳マーカー
    ctx.strokeStyle = AM; ctx.lineWidth = 1.2;
    strokeConn(lm, CONN && CONN.irisL, 1);
    strokeConn(lm, CONN && CONN.irisR, 1);
    [473, 468].forEach(idx=>{
      const p = lm[idx]; if(!p) return;
      const ex = sx(p.x), ey = sy(p.y), r = Math.max(6, fw*0.06);
      ctx.globalAlpha = a*0.8;
      ctx.beginPath(); ctx.arc(ex, ey, r, 0, 6.284); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex-r*1.5, ey); ctx.lineTo(ex-r*0.6, ey);
      ctx.moveTo(ex+r*0.6, ey); ctx.lineTo(ex+r*1.5, ey);
      ctx.stroke();
    });

    // 4) 捕捉スキャンライン
    if(!locked){
      const p = acq;
      ctx.globalAlpha = a*(1-p)*0.9;
      ctx.strokeStyle = CY; ctx.lineWidth = 2;
      const ly = y0 + fh*p;
      ctx.beginPath(); ctx.moveTo(x0-8, ly); ctx.lineTo(x1+8, ly); ctx.stroke();
    }

    // 5) ロックブラケット
    const px = fw*0.16, py = fh*0.1;
    const L = x0-px, R2 = x1+px, T = y0-py*1.6, B = y1+py;
    const grow = lerp(1.25, 1, acq);
    const gL = cx-(cx-L)*grow, gR = cx+(R2-cx)*grow, gT = cy-(cy-T)*grow, gB = cy+(B-cy)*grow;
    const cl2 = Math.min(gR-gL, gB-gT)*0.24;
    ctx.globalAlpha = a;
    ctx.strokeStyle = col; ctx.lineWidth = 1.8;
    [[gL,gT,1,1],[gR,gT,-1,1],[gL,gB,1,-1],[gR,gB,-1,-1]].forEach(([x,y,mx,my])=>{
      ctx.beginPath();
      ctx.moveTo(x, y+my*cl2); ctx.lineTo(x, y); ctx.lineTo(x+mx*cl2, y);
      ctx.stroke();
    });

    // 6) 回転リング
    if(!REDUCED){
      const rr = Math.max(gR-gL, gB-gT)*0.62;
      ctx.globalAlpha = a*0.5;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(S.t*(locked?0.6:2.2));
      for(let i=0;i<3;i++){
        ctx.beginPath();
        ctx.arc(0,0,rr, i*2.094+0.25, i*2.094+1.55);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 7) データパネル＋引き出し線
    const m = faceMetrics(f);
    const right = cx < W/2;
    const px0 = right ? gR + 10 : gL - 10;
    const py0 = gT + 6;
    ctx.globalAlpha = a*0.75;
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(right?gR:gL, py0);
    ctx.lineTo(px0, py0);
    ctx.lineTo(px0 + (right?26:-26), py0);
    ctx.stroke();

    ctx.globalAlpha = a;
    ctx.textAlign = right ? 'left' : 'right';
    const tx = px0 + (right?4:-4);
    font(10,'700'); ctx.fillStyle = col;
    ctx.fillText('TGT-'+pad(f.id), tx, py0-6);
    const rows = [
      ['分類', '人物'],
      ['状態', locked ? 'ロック' : '照合中 '+Math.round(acq*100)+'%'],
      ['距離', m.dist.toFixed(1)+' m'],
      ['向き', (m.yaw>=0?'+':'')+m.yaw.toFixed(0)+'°'],
      ['特徴点', lm.length]
    ];
    rows.forEach((r,i)=>{
      const yy = py0 + 12 + i*13;
      font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.55)';
      ctx.fillText(r[0], tx + (right?0:-46), yy);
      font(8,'600'); ctx.fillStyle = CY;
      ctx.fillText(String(r[1]), tx + (right?34:0), yy);
    });
    ctx.textAlign = 'left';
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawMotionTargets(e){
  ctx.save();
  for(const t of S.tracks){
    const hw = Math.max(26, t.w*0.55), hh = Math.max(26, t.h*0.55);
    const a = clamp(t.life,0,1)*e*0.8;
    ctx.globalAlpha = a;
    ctx.strokeStyle = CY; ctx.lineWidth = 1.2;
    ctx.setLineDash([4,4]);
    ctx.strokeRect(t.x-hw, t.y-hh, hw*2, hh*2);
    ctx.setLineDash([]);
    font(8,'500'); ctx.fillStyle = 'rgba(111,230,255,.75)';
    ctx.fillText('動体', t.x-hw, t.y-hh-5);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ================= 描画：HUD ================= */
function drawReticle(e){
  const cx = W/2, cy = H/2;
  const R = Math.min(W,H)*0.13*(0.6+0.4*e);
  const spin = REDUCED ? 0 : S.t;
  ctx.save();
  ctx.globalAlpha = e*0.9;
  ctx.translate(cx,cy);

  ctx.strokeStyle = 'rgba(111,230,255,.6)'; ctx.lineWidth = 1.3;
  ctx.save(); ctx.rotate(spin*0.5);
  for(let i=0;i<4;i++){
    ctx.beginPath();
    ctx.arc(0,0,R, i*Math.PI/2 + 0.22, i*Math.PI/2 + Math.PI/2 - 0.22);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(111,230,255,.45)'; ctx.lineWidth = 1.1;
  const g0 = R*0.2, g1 = R*0.55;
  [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
    ctx.beginPath(); ctx.moveTo(dx*g0, dy*g0); ctx.lineTo(dx*g1, dy*g1); ctx.stroke();
  });
  ctx.fillStyle = AM;
  ctx.beginPath(); ctx.arc(0,0,1.8,0,6.284); ctx.fill();
  ctx.restore();

  let msg, col;
  if(S.faceState === 'loading'){ msg = '顔認識モデル 読込中'; col = 'rgba(111,230,255,.7)'; }
  else if(S.faceState === 'error'){ msg = '顔認識 利用不可（動体検知で継続）'; col = RD; }
  else if(faces.length){ msg = '顔を捕捉 '+faces.length; col = AM; }
  else { msg = '走査中'; col = 'rgba(111,230,255,.6)'; }
  font(9,'600');
  ctx.textAlign = 'center';
  ctx.globalAlpha = e;
  ctx.fillStyle = col;
  ctx.fillText(msg, cx, cy + R*1.8);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawTop(e){
  const y = Math.max(26, H*0.045) - (1-e)*24;
  const m = Math.max(24, W*0.05);
  ctx.save(); ctx.globalAlpha = e;
  font(10,'700'); ctx.fillStyle = CY;
  ctx.fillText('J.A.R.V.I.S.', m, y);
  font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.55)';
  ctx.fillText('MARK  LXXXV  /  顔認識モード', m, y+13);

  const d = new Date();
  font(11,'600'); ctx.textAlign = 'center'; ctx.fillStyle = '#dff7ff';
  ctx.fillText(pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()), W/2, y);
  font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.5)';
  ctx.fillText('経過 '+pad(S.t/60)+':'+pad(S.t%60), W/2, y+13);

  ctx.textAlign = 'right';
  font(9,'600'); ctx.fillStyle = CY;
  const bt = S.battery ? Math.round(S.battery.level*100)+'%' : '—';
  ctx.fillText('電源 '+bt, W-m, y);
  font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.5)';
  ctx.fillText(Math.round(S.fps)+' FPS   '+(V.videoWidth||0)+'×'+(V.videoHeight||0), W-m, y+13);
  ctx.textAlign = 'left';
  ctx.restore();
}

function drawLeft(e){
  const m = Math.max(24, W*0.05) - (1-e)*40;
  const top = H*0.3, h = H*0.34;
  ctx.save(); ctx.globalAlpha = e;

  const segs = 16, sh = h/segs;
  const power = 0.62 + 0.3*Math.abs(Math.sin(S.t*0.5));
  for(let i=0;i<segs;i++){
    const on = (segs-i)/segs <= clamp(power,0,1);
    ctx.fillStyle = on ? (i<3?AM:CY) : 'rgba(111,230,255,.12)';
    ctx.globalAlpha = e*(on?0.8:0.9);
    ctx.fillRect(m, top+i*sh, 4, sh-3);
  }
  ctx.globalAlpha = e;

  const faceLabel = S.faceState==='ready' ? '稼働'
                  : S.faceState==='loading' ? '読込中'
                  : S.faceState==='error' ? '不可' : '待機';
  const rows = [
    ['顔認識', faceLabel],
    ['検出数', faces.length+' 人'],
    ['特徴点', faces.length? faces[0].lm.length : 0],
    ['カメラ', mirrored()?'前面':'背面'],
    ['動体', S.tracks.length]
  ];
  const ry = top+h+22;
  rows.forEach((r,i)=>{
    font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.5)';
    ctx.fillText(r[0], m, ry+i*14);
    font(8,'600');
    ctx.fillStyle = (i===0 && S.faceState==='error') ? RD : CY;
    ctx.fillText(String(r[1]), m+56, ry+i*14);
  });
  ctx.restore();
}

function drawCompass(e){
  const y = H - Math.max(30, H*0.05) + (1-e)*30;
  const halfW = Math.min(W*0.32, 190);
  const cx = W/2;
  const hd = S.headingLive ? S.heading : (S.t*6)%360;
  ctx.save(); ctx.globalAlpha = e*0.9;
  ctx.strokeStyle = 'rgba(111,230,255,.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx-halfW, y); ctx.lineTo(cx+halfW, y); ctx.stroke();

  const names = {0:'北',90:'東',180:'南',270:'西'};
  ctx.textAlign = 'center';
  for(let a = -60; a <= 60; a += 10){
    const deg = (Math.round(hd/10)*10 + a + 360) % 360;
    const off = (deg - hd + 540) % 360 - 180;
    if(Math.abs(off) > 62) continue;
    const x = cx + off/60*halfW;
    const major = deg % 30 === 0;
    ctx.strokeStyle = 'rgba(111,230,255,'+(major?0.6:0.28)+')';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y-(major?8:5)); ctx.stroke();
    if(major){
      font(8, names[deg]?'700':'400');
      ctx.fillStyle = names[deg] ? '#dff7ff' : 'rgba(111,230,255,.5)';
      ctx.fillText(names[deg] || deg, x, y+12);
    }
  }
  ctx.fillStyle = AM;
  ctx.beginPath(); ctx.moveTo(cx,y-12); ctx.lineTo(cx-5,y-19); ctx.lineTo(cx+5,y-19); ctx.closePath(); ctx.fill();
  font(9,'600'); ctx.fillStyle = '#dff7ff';
  ctx.fillText(pad(hd,3)+'°', cx, y-25);
  ctx.textAlign = 'left';
  ctx.restore();
}

const BOOT_LINES = [
  '電源系  接続',
  '光学センサー  同期',
  '顔認識モデル  読込',
  '照準演算  常駐',
  '全システム  正常'
];
function drawBoot(bp){
  const fade = bp < 0.8 ? 1 : 1-(bp-0.8)/0.2;
  ctx.save();
  ctx.globalAlpha = fade*0.9;
  ctx.fillStyle = 'rgba(2,7,11,'+(0.85 - bp*0.6)+')';
  ctx.fillRect(0,0,W,H);

  const cx = W/2, cy = H/2;
  const R = Math.min(W,H)*0.28;
  ctx.globalAlpha = fade;
  ctx.strokeStyle = CY; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI/2, -Math.PI/2 + easeOut(clamp(bp/0.7,0,1))*6.283);
  ctx.stroke();

  ctx.textAlign = 'center';
  font(13,'700'); ctx.fillStyle = '#dff7ff';
  ctx.fillText('起  動  中', cx, cy - 8);
  font(9,'400'); ctx.fillStyle = CY;
  ctx.fillText(Math.round(clamp(bp/0.85,0,1)*100)+'%', cx, cy + 12);

  ctx.textAlign = 'left';
  const lx = Math.max(28, W*0.08), ly = cy + R + 18;
  BOOT_LINES.forEach((s,i)=>{
    const at = 0.1 + i*0.15;
    if(bp < at) return;
    ctx.globalAlpha = fade*clamp((bp-at)/0.08,0,1);
    font(9,'500'); ctx.fillStyle = 'rgba(111,230,255,.8)';
    ctx.fillText('› '+s, lx, ly + i*15);
    ctx.fillStyle = AM;
    ctx.fillText('OK', W-lx-16, ly + i*15);
  });
  ctx.restore();
  ctx.textAlign = 'left';
}

/* ================= ループ ================= */
let last = performance.now();
let motionSkip = 0;
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now-last)/1000); last = now;
  if(!S.running) return;
  S.t += dt;
  S.fps = lerp(S.fps, 1/Math.max(dt,0.001), 0.08);
  if(S.bootT < BOOT) S.bootT += dt;
  const bp = clamp(S.bootT/BOOT, 0, 1);
  const e = easeOut(clamp((bp-0.3)/0.7, 0, 1));

  updateVideoRect();
  ctx.clearRect(0,0,W,H);
  drawVideo();

  detectFaces(now);
  if(!faces.length && (++motionSkip % 2 === 0)) updateTracks(detectMotion(), dt*2);
  else if(faces.length) S.tracks.length = 0;

  if(e > 0){
    if(!faces.length) drawMotionTargets(e);
    drawFaces(e);
    drawReticle(e);
    drawTop(e);
    drawLeft(e);
    drawCompass(e);
  }
  drawVisor(Math.max(e,0.2));
  drawScan();
  if(bp < 1) drawBoot(bp);
}
requestAnimationFrame(frame);

/* ================= 操作 ================= */
document.getElementById('bStart').addEventListener('click', start);
document.getElementById('core').addEventListener('click', start);
document.getElementById('bStop').addEventListener('click', stop);

document.getElementById('bSwap').addEventListener('click', async ()=>{
  const prev = S.facing;
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  try{ await openCamera(); tone(660,0.07,'square',0.03); }
  catch(e){ S.facing = prev; try{ await openCamera(); }catch(_){} }
});

const bGrade = document.getElementById('bGrade');
bGrade.addEventListener('click', ()=>{
  S.grade = !S.grade;
  bGrade.textContent = S.grade ? '映像補正 ON' : '映像補正 OFF';
  bGrade.dataset.off = S.grade ? '0' : '1';
});

const bSound = document.getElementById('bSound');
bSound.addEventListener('click', ()=>{
  S.sound = !S.sound;
  bSound.textContent = S.sound ? '音 ON' : '音 OFF';
  bSound.dataset.off = S.sound ? '0' : '1';
  if(S.sound) tone(990,0.06,'square',0.03);
});

document.getElementById('bFull').addEventListener('click', ()=>{
  const el = document.documentElement;
  if(!document.fullscreenElement){
    (el.requestFullscreen || el.webkitRequestFullscreen || (()=>{})).call(el);
  }else{
    (document.exitFullscreen || document.webkitExitFullscreen || (()=>{})).call(document);
  }
});

document.getElementById('bSnap').addEventListener('click', ()=>{
  flash.classList.add('on');
  setTimeout(()=>flash.classList.remove('on'), 60);
  tone(1200,0.05,'square',0.035);
  try{
    C.toBlob(b=>{
      if(!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'mark-hud-' + Date.now() + '.png';
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }catch(e){}
});

if(navigator.getBattery) navigator.getBattery().then(b=>{ S.battery = b; }).catch(()=>{});
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) prevGray = null; });
})();
