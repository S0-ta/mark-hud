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
const BOOT = 2.7;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

let W = 0, H = 0, DPR = 1;
const S = {
  running:false, bootT:0, t:0, facing:'environment', sound:true,
  stream:null, tracks:[], nextId:1, fps:60, heading:0, headingLive:false,
  battery:null, shake:0
};

const clamp = (v,a,b)=>v<a?a:(v>b?b:v);
const lerp  = (a,b,k)=>a+(b-a)*k;
const easeOut = t => 1-Math.pow(1-t,3);
const pad = (n,l=2)=>String(Math.floor(n)).padStart(l,'0');
const FF = getComputedStyle(document.body).fontFamily || 'monospace';
function font(px,w=500){ ctx.font = w+' '+px+'px '+FF; }

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
  tone(180, 0.9, 'sawtooth', 0.035, 720);
  setTimeout(()=>tone(880,0.08,'square',0.03), 900);
  setTimeout(()=>tone(1320,0.08,'square',0.03), 1030);
  setTimeout(()=>tone(1760,0.16,'sine',0.04), 1160);
}

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

/* ---- 動体検知 ---- */
const PW = 84, PH = 63;
const pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
const pctx = pc.getContext('2d', {willReadFrequently:true});
let prevGray = null;
const labels = new Int16Array(PW*PH);
const stack = new Int32Array(PW*PH);

function detect(){
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
  return blobs.slice(0,4);
}

function videoRect(){
  const vw = V.videoWidth || 16, vh = V.videoHeight || 9;
  const s = Math.max(W/vw, H/vh);
  const dw = vw*s, dh = vh*s;
  return { x:(W-dw)/2, y:(H-dh)/2, w:dw, h:dh };
}
const mirrored = () => S.facing === 'user';

function toScreen(b){
  const r = videoRect();
  const nx = mirrored() ? 1-b.nx : b.nx;
  return { x:r.x + nx*r.w, y:r.y + b.ny*r.h, w:b.nw*r.w, h:b.nh*r.h };
}

function updateTracks(blobs, dt){
  for(const t of S.tracks) t.hit = false;
  for(const b of blobs){
    const p = toScreen(b);
    let best = null, bd = 1e9;
    for(const t of S.tracks){
      if(t.hit) continue;
      const d = Math.hypot(t.tx-p.x, t.ty-p.y);
      if(d < bd){ bd = d; best = t; }
    }
    if(best && bd < Math.max(W,H)*0.2){
      best.tx = p.x; best.ty = p.y;
      best.tw = Math.max(best.tw*0.75, p.w); best.th = Math.max(best.th*0.75, p.h);
      best.hit = true; best.life = 1;
    }else{
      S.tracks.push({
        id:S.nextId++, x:p.x, y:p.y, w:p.w, h:p.h,
        tx:p.x, ty:p.y, tw:p.w, th:p.h,
        life:1, age:0, hit:true, locked:false
      });
    }
  }
  const k = clamp(dt*9, 0, 1);
  for(const t of S.tracks){
    if(!t.hit) t.life -= dt/0.75;
    t.age += dt;
    t.x = lerp(t.x, t.tx, k); t.y = lerp(t.y, t.ty, k);
    t.w = lerp(t.w, t.tw, k*0.7); t.h = lerp(t.h, t.th, k*0.7);
    if(!t.locked && t.age > 0.32){ t.locked = true; tone(1480, 0.06, 'square', 0.028); }
  }
  S.tracks = S.tracks.filter(t=>t.life > 0);
  if(S.tracks.length > 4){
    S.tracks.sort((a,b)=>(b.w*b.h)-(a.w*a.h));
    S.tracks.length = 4;
  }
}

function drawVideo(){
  const r = videoRect();
  ctx.save();
  if(mirrored()){ ctx.translate(W,0); ctx.scale(-1,1); }
  try{ ctx.drawImage(V, r.x, r.y, r.w, r.h); }catch(e){}
  ctx.restore();

  // 色調：青寄せ＋周辺減光（映像が潰れない範囲に抑える）
  ctx.fillStyle = 'rgba(4,26,40,.15)';
  ctx.fillRect(0,0,W,H);
  const vg = ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.42, W/2,H/2,Math.max(W,H)*0.75);
  vg.addColorStop(0,'rgba(0,0,0,0)');
  vg.addColorStop(1,'rgba(0,8,14,.55)');
  ctx.fillStyle = vg; ctx.fillRect(0,0,W,H);
}

function drawScan(){
  ctx.save();
  ctx.globalAlpha = 0.045; ctx.fillStyle = CY;
  for(let y = (S.t*46)%4; y < H; y += 4) ctx.fillRect(0, y, W, 1);
  ctx.globalAlpha = 0.07;
  const sy = (S.t*0.34 % 1.6 - 0.3) * H;
  const g = ctx.createLinearGradient(0, sy-90, 0, sy+90);
  g.addColorStop(0,'rgba(111,230,255,0)');
  g.addColorStop(.5,'rgba(111,230,255,1)');
  g.addColorStop(1,'rgba(111,230,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, sy-90, W, 180);
  ctx.restore();
}

// バイザー開口（八角形）※beginPathは呼び出し側で行う（複合パス構築のため）
function visorPath(inset, chamfer){
  const l = inset, r = W-inset, t = inset, b = H-inset, c = chamfer;
  ctx.moveTo(l+c, t); ctx.lineTo(r-c, t); ctx.lineTo(r, t+c);
  ctx.lineTo(r, b-c); ctx.lineTo(r-c, b); ctx.lineTo(l+c, b);
  ctx.lineTo(l, b-c); ctx.lineTo(l, t+c); ctx.closePath();
}
function drawVisor(e){
  const inset = Math.max(7, Math.min(W,H)*0.018);
  const ch = Math.min(W,H)*0.11;
  // 外周だけを暗く（全画面矩形＋八角形の複合パスをevenoddで塗る）
  ctx.save();
  ctx.beginPath();
  ctx.rect(0,0,W,H);
  visorPath(inset, ch);
  ctx.fillStyle = 'rgba(2,7,11,.95)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = e;
  ctx.strokeStyle = 'rgba(111,230,255,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); visorPath(inset, ch); ctx.stroke();
  ctx.strokeStyle = 'rgba(111,230,255,.15)'; ctx.lineWidth = 1;
  ctx.beginPath(); visorPath(inset+7, ch-5); ctx.stroke();
  ctx.restore();
}

function drawReticle(e){
  const cx = W/2, cy = H/2;
  const R = Math.min(W,H)*0.15*(0.6+0.4*e);
  const spin = REDUCED ? 0 : S.t;
  ctx.save();
  ctx.globalAlpha = e;
  ctx.translate(cx,cy);

  ctx.strokeStyle = 'rgba(111,230,255,.75)'; ctx.lineWidth = 1.4;
  ctx.save(); ctx.rotate(spin*0.5);
  for(let i=0;i<4;i++){
    ctx.beginPath();
    ctx.arc(0,0,R, i*Math.PI/2 + 0.22, i*Math.PI/2 + Math.PI/2 - 0.22);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(111,230,255,.3)'; ctx.lineWidth = 1;
  ctx.save(); ctx.rotate(-spin*0.28);
  for(let i=0;i<3;i++){
    ctx.beginPath();
    ctx.arc(0,0,R*0.74, i*2*Math.PI/3, i*2*Math.PI/3 + 1.1);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(111,230,255,.45)';
  for(let a=0; a<360; a+=15){
    const rad = a*Math.PI/180;
    const long = a%45===0;
    ctx.lineWidth = long?1.4:1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(rad)*(R*1.1), Math.sin(rad)*(R*1.1));
    ctx.lineTo(Math.cos(rad)*(R*(long?1.22:1.16)), Math.sin(rad)*(R*(long?1.22:1.16)));
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(111,230,255,.85)'; ctx.lineWidth = 1.2;
  const g0 = R*0.16, g1 = R*0.5;
  [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
    ctx.beginPath(); ctx.moveTo(dx*g0, dy*g0); ctx.lineTo(dx*g1, dy*g1); ctx.stroke();
  });
  ctx.fillStyle = AM;
  ctx.beginPath(); ctx.arc(0,0,1.9,0,6.284); ctx.fill();
  ctx.restore();

  const n = S.tracks.length;
  font(9,'600');
  ctx.textAlign = 'center';
  ctx.globalAlpha = e;
  ctx.fillStyle = n ? AM : 'rgba(111,230,255,.6)';
  ctx.fillText(n ? '目標を捕捉 ' + n : '走査中', cx, cy + R*1.6);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawTargets(e){
  ctx.save();
  ctx.globalAlpha = e;
  for(const t of S.tracks){
    const grow = t.locked ? 1 : lerp(1.5, 1, clamp(t.age/0.32,0,1));
    const hw = Math.max(30, t.w*0.6)*grow, hh = Math.max(30, t.h*0.6)*grow;
    const a = clamp(t.life,0,1);
    const col = t.locked ? AM : CY;
    ctx.globalAlpha = e*a;
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    const cl = Math.min(hw,hh)*0.42;
    const L = t.x-hw, R2 = t.x+hw, T = t.y-hh, B = t.y+hh;
    [[L,T,1,1],[R2,T,-1,1],[L,B,1,-1],[R2,B,-1,-1]].forEach(([x,y,sx,sy])=>{
      ctx.beginPath();
      ctx.moveTo(x, y+sy*cl); ctx.lineTo(x, y); ctx.lineTo(x+sx*cl, y);
      ctx.stroke();
    });
    if(t.locked && !REDUCED){
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      const p = (S.t*1.6)%1;
      ctx.beginPath(); ctx.arc(t.x, t.y, Math.max(hw,hh)*(0.6+p*0.85), 0, 6.284);
      ctx.globalAlpha = e*a*(1-p)*0.4; ctx.stroke();
    }
    ctx.globalAlpha = e*a;
    font(9,'600'); ctx.fillStyle = col;
    ctx.fillText('TGT-' + pad(t.id), L, T-7);
    font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.7)';
    const dist = clamp(240/Math.max(hw,hh)*10, 1.2, 99);
    ctx.fillText((t.locked ? 'ロック' : '照合') + '  ' + dist.toFixed(1) + 'm', L, B+13);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawTop(e){
  const y = Math.max(26, H*0.045) - (1-e)*24;
  const m = Math.max(26, W*0.055);
  ctx.save(); ctx.globalAlpha = e;
  font(10,'700'); ctx.fillStyle = CY;
  ctx.fillText('J.A.R.V.I.S.', m, y);
  font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.55)';
  ctx.fillText('MARK  LXXXV  /  視界オーバーレイ', m, y+13);

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
  const m = Math.max(26, W*0.055) - (1-e)*40;
  const top = H*0.28, h = H*0.42;
  ctx.save(); ctx.globalAlpha = e;

  const segs = 18, sh = h/segs;
  const power = 0.62 + 0.3*Math.abs(Math.sin(S.t*0.5)) + S.shake*0.4;
  for(let i=0;i<segs;i++){
    const on = (segs-i)/segs <= clamp(power,0,1);
    ctx.fillStyle = on ? (i<3?AM:CY) : 'rgba(111,230,255,.12)';
    ctx.globalAlpha = e*(on?0.85:1);
    ctx.fillRect(m, top+i*sh, 5, sh-3);
  }
  ctx.globalAlpha = e;
  ctx.save();
  ctx.translate(m-6, top+h);
  ctx.rotate(-Math.PI/2);
  font(8,'600'); ctx.fillStyle = 'rgba(111,230,255,.65)';
  ctx.fillText('リパルサー出力', 0, 0);
  ctx.restore();

  const rows = [
    ['推進系','正常'],
    ['装甲','100%'],
    ['熱交換', (34+Math.sin(S.t*0.7)*3).toFixed(1)+'℃'],
    ['検知感度', S.shake>0.5?'再取得中':'高'],
    ['追尾', S.tracks.length+' / 4']
  ];
  const ry = top+h+26;
  rows.forEach((r,i)=>{
    font(8,'400'); ctx.fillStyle = 'rgba(111,230,255,.5)';
    ctx.fillText(r[0], m, ry+i*14);
    font(8,'600'); ctx.fillStyle = i===3 && S.shake>0.5 ? RD : CY;
    ctx.fillText(r[1], m+68, ry+i*14);
  });
  ctx.restore();
}

function drawRight(e){
  const m = W - Math.max(26, W*0.055) + (1-e)*40;
  const cy = H*0.5, half = H*0.2;
  ctx.save(); ctx.globalAlpha = e;
  ctx.textAlign = 'right';

  const base = 120 + Math.sin(S.t*0.4)*18;
  ctx.strokeStyle = 'rgba(111,230,255,.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(m, cy-half); ctx.lineTo(m, cy+half); ctx.stroke();
  for(let i=-4;i<=4;i++){
    const val = Math.round((base + i*10)/10)*10;
    const yy = cy - (val - base)*(half/45);
    if(yy < cy-half || yy > cy+half) continue;
    const major = val % 20 === 0;
    ctx.strokeStyle = 'rgba(111,230,255,'+(major?0.6:0.28)+')';
    ctx.beginPath(); ctx.moveTo(m, yy); ctx.lineTo(m-(major?14:8), yy); ctx.stroke();
    if(major){ font(8,'400'); ctx.fillStyle='rgba(111,230,255,.55)'; ctx.fillText(String(val), m-19, yy+3); }
  }
  ctx.fillStyle = AM;
  ctx.beginPath(); ctx.moveTo(m,cy); ctx.lineTo(m-8,cy-5); ctx.lineTo(m-8,cy+5); ctx.closePath(); ctx.fill();
  font(9,'600'); ctx.fillStyle = '#dff7ff';
  ctx.fillText(base.toFixed(0)+' m', m-13, cy-half-9);
  font(8,'400'); ctx.fillStyle='rgba(111,230,255,.5)';
  ctx.fillText('高度', m, cy+half+15);
  ctx.textAlign = 'left';
  ctx.restore();
}

function drawCompass(e){
  const y = H - Math.max(34, H*0.055) + (1-e)*30;
  const halfW = Math.min(W*0.34, 200);
  const cx = W/2;
  const hd = S.headingLive ? S.heading : (S.t*6)%360;
  ctx.save(); ctx.globalAlpha = e;
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
    ctx.strokeStyle = 'rgba(111,230,255,'+(major?0.65:0.3)+')';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y-(major?9:5)); ctx.stroke();
    if(major){
      font(8, names[deg]?'700':'400');
      ctx.fillStyle = names[deg] ? '#dff7ff' : 'rgba(111,230,255,.55)';
      ctx.fillText(names[deg] || deg, x, y+12);
    }
  }
  ctx.fillStyle = AM;
  ctx.beginPath(); ctx.moveTo(cx,y-13); ctx.lineTo(cx-5,y-21); ctx.lineTo(cx+5,y-21); ctx.closePath(); ctx.fill();
  font(9,'600'); ctx.fillStyle = '#dff7ff';
  ctx.fillText(pad(hd,3)+'°', cx, y-27);
  if(!S.headingLive){
    font(7,'400'); ctx.fillStyle='rgba(111,230,255,.35)';
    ctx.fillText('方位センサー未接続', cx, y+24);
  }
  ctx.textAlign = 'left';
  ctx.restore();
}

const BOOT_LINES = [
  '電源系  接続',
  '光学センサー  同期',
  '動体検知  校正',
  '照準演算  常駐',
  '全システム  正常'
];
function drawBoot(bp){
  const fade = bp < 0.8 ? 1 : 1-(bp-0.8)/0.2;
  ctx.save();
  ctx.globalAlpha = fade*0.9;
  ctx.fillStyle = 'rgba(2,7,11,'+(0.9 - bp*0.55)+')';
  ctx.fillRect(0,0,W,H);

  const cx = W/2, cy = H/2;
  const R = Math.min(W,H)*0.3;
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
  const lx = Math.max(30, W*0.09), ly = cy + R + 18;
  BOOT_LINES.forEach((s,i)=>{
    const at = 0.12 + i*0.14;
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

let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now-last)/1000); last = now;
  if(!S.running) return;
  S.t += dt;
  S.fps = lerp(S.fps, 1/Math.max(dt,0.001), 0.08);
  if(S.bootT < BOOT) S.bootT += dt;
  const bp = clamp(S.bootT/BOOT, 0, 1);
  const e = easeOut(clamp((bp-0.35)/0.65, 0, 1));

  ctx.clearRect(0,0,W,H);
  drawVideo();
  updateTracks(detect(), dt);
  if(e > 0){
    drawTargets(e);
    drawReticle(e);
    drawTop(e);
    drawLeft(e);
    drawRight(e);
    drawCompass(e);
  }
  drawVisor(Math.max(e,0.2));
  drawScan();
  if(bp < 1) drawBoot(bp);
}
requestAnimationFrame(frame);

document.getElementById('bStart').addEventListener('click', start);
document.getElementById('core').addEventListener('click', start);
document.getElementById('bStop').addEventListener('click', stop);

document.getElementById('bSwap').addEventListener('click', async ()=>{
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  try{ await openCamera(); tone(660,0.07,'square',0.03); }
  catch(e){ S.facing = S.facing === 'user' ? 'environment' : 'user'; try{ await openCamera(); }catch(_){} }
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
