const WORKER_URL = 'https://registrasi-unz-api.formsurveyhth.workers.dev';
const SCAN_COOLDOWN_MS = 4000; // after one full flow, ignore same code for 4s
let activeScan = false; // single-flight lock
const state = { token:null, admin_id:null, currentCode:null, lastResult:null, role:null, stream:null, devices:[], deviceIndex:0, paused:false, recentCodes:new Map() };
const els = {
  loginForm: document.getElementById('loginForm'),
  loginMsg: document.getElementById('loginMsg'),
  authSection: document.getElementById('authSection'),
  scanner: document.getElementById('scanner'),
  video: document.getElementById('video'),
  status: document.getElementById('scanStatus'),
  manualCode: document.getElementById('manualCode'),
  validateBtn: document.getElementById('validateBtn'),
  markBtn: document.getElementById('markBtn'),
  resultLog: document.getElementById('resultLog'),
  adminInfo: document.getElementById('adminInfo'),
  roleTag: document.getElementById('roleTag'),
  toggleCamBtn: document.getElementById('toggleCamBtn'),
  switchCamBtn: document.getElementById('switchCamBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  camState: document.getElementById('camState'),
  logCount: document.getElementById('logCount'),
  forceResetCamBtn: document.getElementById('forceResetCamBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
};

function log(line, cls){
  const div=document.createElement('div');
  div.textContent=line;
  if(cls) div.classList.add(cls);
  els.resultLog.prepend(div);
  // keep only last 300 entries
  while(els.resultLog.children.length>300) els.resultLog.removeChild(els.resultLog.lastChild);
  els.logCount.textContent = els.resultLog.children.length+' items';
}

function feedback(ok=true){
  try{
    const ctx=new AudioContext();
    const osc=ctx.createOscillator();
    osc.type='sine';
    osc.frequency.value= ok?880:200;
    const gain=ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();osc.stop(ctx.currentTime+0.3);
  }catch{}
  if(navigator.vibrate){ try{ navigator.vibrate(ok?[40,40]:[120,60,120]); }catch{} }
}

function setStatus(msg, cls){
  els.status.textContent=msg;
  els.status.className='status '+(cls||'');
  els.status.classList.add('flash');
  setTimeout(()=>els.status.classList.remove('flash'),400);
}

function saveAuth(data){
  state.token=data.token; state.admin_id=data.admin_id;
  localStorage.setItem('gateAuth', JSON.stringify({token:data.token, admin_id:data.admin_id}));
}
function loadAuth(){
  try{const j=JSON.parse(localStorage.getItem('gateAuth')); if(j&&j.token){state.token=j.token;state.admin_id=j.admin_id;return true}}catch{}
  return false;
}

async function login(username,password){
  const r=await fetch(WORKER_URL+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const j=await r.json();
  if(j.ok){ saveAuth(j); state.role=j.role||'staff'; els.adminInfo.textContent=j.admin_id; els.roleTag.textContent=state.role; els.roleTag.classList.remove('hidden'); els.authSection.classList.add('hidden'); els.scanner.classList.remove('hidden'); startVideo(); setStatus('Login OK','ok'); initGateWSIfToken(); }
  else { els.loginMsg.textContent=j.error||'Login failed'; }
}

els.loginForm.addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(els.loginForm);login(fd.get('username'),fd.get('password'));});

if(loadAuth()) { els.authSection.classList.add('hidden'); els.scanner.classList.remove('hidden'); startVideo(); }

async function api(path, body){
  const r=await fetch(WORKER_URL+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.token,'Origin':'https://registrasi-unz.web.app'},body:JSON.stringify(body)});
  return { status:r.status, json: await r.json() };
}

// Attempt to extract pure ticket code from arbitrary scanned text/URL.
function extractCode(raw){
  if(!raw) return '';
  let t = raw.trim();
  // If looks like URL containing ?p=CODE
  if(/https?:/i.test(t)){
    try {
      const u = new URL(t);
      const p = u.searchParams.get('p');
      if(p) return p.trim().toUpperCase();
      // else try last path segment
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if(seg && /^[A-Za-z0-9]{4,10}$/.test(seg)) return seg.toUpperCase();
    } catch {}
  }
  // Direct code pasted? Clean non code chars
  const m = t.toUpperCase().match(/[A-Z0-9]{4,10}/);
  if(m) return m[0];
  return t.toUpperCase();
}

async function validate(code){
  if(activeScan) return; // another scan in progress
  if(state.recentCodes.has(code)) return; // already processed recently
  activeScan = true;
  const now=Date.now();
  for(const [k,v] of state.recentCodes){ if(now - v > SCAN_COOLDOWN_MS) state.recentCodes.delete(k); }
  state.recentCodes.set(code, Date.now());
  setStatus('Memeriksa...','');
  const {status,json}=await api('/validate',{code}).catch(()=>({status:0,json:{}}));
  if(status===200 && json && json.ok){
    state.currentCode=code; els.markBtn.disabled=true;
    const nameDisplay = json.name || '';
    if(!json.used){
      // langsung auto mark
      await autoMark(code, nameDisplay);
    } else {
      setStatus('Telah Registrasi Sebelumnya','warn');
      log(`${new Date().toLocaleTimeString()} ALREADY ${code} ${nameDisplay}`,'warn');
      feedback(true);
    }
  } else if(status===404){ setStatus('Tiket Tidak Ditemukan','err'); feedback(false); log(`${new Date().toLocaleTimeString()} NF ${code}`,'err'); }
  else if(status===401){ setStatus('Tidak diizinkan','err'); }
  else { setStatus('Kesalahan Sistem','err'); log(`${new Date().toLocaleTimeString()} ERR ${code} ${(json&&json.error)||status}`,'err'); }
  // release after a short delay to avoid same frame multi trigger
  setTimeout(()=>{ activeScan=false; }, 600);
}

async function autoMark(code, nameDisplay){
  const {status,json}=await api('/mark-used',{code, admin_id: state.admin_id}).catch(()=>({status:0,json:{}}));
  if(status===200 && json && json.ok && json.result==='USED'){
    setStatus('Berhasil Registrasi','ok');
    feedback(true);
    log(`${new Date().toLocaleTimeString()} BERHASIL ${code} ${nameDisplay}`,'used');
  } else if(json && json.error==='ALREADY_USED') {
    setStatus('Telah Registrasi Sebelumnya','warn');
    feedback(true);
    log(`${new Date().toLocaleTimeString()} ALREADY ${code} ${nameDisplay}`,'warn');
  } else if(status===429) {
    setStatus('Terlalu Cepat (Rate Limit)','warn');
  } else {
    setStatus('Gagal Registrasi','err');
    feedback(false);
    log(`${new Date().toLocaleTimeString()} FAIL ${code} ${(json&&json.error)||status}`,'err');
  }
  setTimeout(()=>{ if(state.currentCode===code){ state.currentCode=null; } },800);
}

// Manual mark kept for fallback (hidden button maybe)
async function mark(){
  if(!state.currentCode) return;
  const code = state.currentCode;
  const {status,json}=await api('/mark-used',{code, admin_id: state.admin_id});
  if(status===200){ setStatus('Berhasil Registrasi','ok'); feedback(true); log(`${new Date().toLocaleTimeString()} BERHASIL ${code}`,'used'); }
  else if(json.error==='ALREADY_USED'){ setStatus('Telah Registrasi Sebelumnya','warn'); feedback(true); log(`${new Date().toLocaleTimeString()} ALREADY ${code}`,'warn'); }
  else { setStatus('Gagal Registrasi','err'); feedback(false); log(`${new Date().toLocaleTimeString()} FAIL ${code} ${json.error||status}`,'err'); }
  state.recentCodes.set(code, Date.now());
  setTimeout(()=>{ els.manualCode.value=''; state.currentCode=null; },1500);
}

// ============= Camera & Scan =============
let scanning=false; let detector=null; let useFallback=false; let canvas=null; let ctx=null;
async function enumerateDevices(){
  try{ const list=await navigator.mediaDevices.enumerateDevices(); state.devices=list.filter(d=>d.kind==='videoinput'); }
  catch{}
}

async function startVideo(){
  try{
    await enumerateDevices();
    let constraints={video:{facingMode:{ideal:'environment'}}};
    if(state.devices.length){
      const dev = state.devices[state.deviceIndex % state.devices.length];
      constraints = { video: { deviceId: { exact: dev.deviceId } } };
    }
    const stream=await navigator.mediaDevices.getUserMedia(constraints);
    state.stream=stream;
    els.video.srcObject=stream; await els.video.play();
    if('BarcodeDetector' in window){
      try { detector=new window.BarcodeDetector({formats:['qr_code']}); }
      catch { detector=null; }
    }
    if(!detector){
      useFallback=true;
      if(!canvas){ canvas=document.createElement('canvas'); ctx=canvas.getContext('2d'); }
      setStatus('Mode fallback (jsQR)','warn');
      if(!window.jsQR){ await import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'); }
    }
    scanning=true; tick();
    els.camState.textContent = state.paused? 'tidak':'ya';
  }catch(e){
    let msg='Kamera diblokir';
    if(e && e.name){
      if(e.name==='NotAllowedError' || e.name==='PermissionDeniedError') msg='Izin kamera ditolak';
      else if(e.name==='NotFoundError' || e.name==='DevicesNotFoundError') msg='Tidak ada kamera ditemukan';
      else if(e.name==='NotReadableError' || e.name==='TrackStartError') msg='Kamera sedang dipakai aplikasi lain';
      else if(e.name==='OverconstrainedError') msg='Kamera tidak mendukung constraint';
      else if(e.name==='SecurityError') msg='Keamanan browser menolak akses';
    }
    setStatus(msg,'err');
    console.error('getUserMedia error', e);
    injectCameraHelp(msg, e);
  }
}

function stopVideoTracks(){
  try { if(state.stream){ for(const t of state.stream.getTracks()) t.stop(); } } catch{}
  state.stream=null; detector=null; useFallback=false; scanning=false; els.video.srcObject=null;
}

async function forceResetCamera(){
  setStatus('Force reset kamera...','warn');
  stopVideoTracks();
  // Small delay to ensure hardware release especially on Android
  setTimeout(()=>{ startVideo().then(()=> setStatus('Kamera di-reset','ok')).catch(()=> setStatus('Reset gagal','err')); }, 150);
}

function injectCameraHelp(msg, err){
  if(document.getElementById('camHelp')) return;
  const wrap=document.createElement('div');
  wrap.id='camHelp';
  wrap.style.cssText='margin-top:8px;font-size:.65rem;line-height:1.3;background:#2a1a1a;padding:8px 10px;border:1px solid #442; border-radius:6px';
  wrap.innerHTML=`<strong style="display:block;margin-bottom:4px">Bantuan Kamera</strong>
  <div style='opacity:.85'>${msg}. Ikuti langkah di bawah ini:</div>
  <ol style='margin:6px 0 6px 14px;padding:0'>
    <li>Pastikan menggunakan HTTPS (sudah).</li>
    <li>Buka pengaturan situs (ikon gembok di address bar).</li>
    <li>Pilih Izin → Kamera → Izinkan.</li>
    <li>Tutup dan buka ulang tab jika masih gagal.</li>
    <li>Pastikan tidak ada aplikasi lain (WhatsApp, kamera) sedang aktif.</li>
  </ol>
  <button id='retryCamBtn' style='background:#275c9b;color:#fff;border:0;padding:6px 10px;border-radius:4px;font-size:.7rem;cursor:pointer;margin-right:6px'>Coba Lagi</button>
  <button id='testPromptBtn' style='background:#444;color:#fff;border:0;padding:6px 10px;border-radius:4px;font-size:.7rem;cursor:pointer'>Tes Prompt</button>
  <div style='margin-top:6px;opacity:.6'>Kode: <code style='font-size:10px'>${(err && err.name)||'?'}</code></div>`;
  els.scanner.appendChild(wrap);
  document.getElementById('retryCamBtn').onclick=()=>{ wrap.remove(); startVideo(); };
  document.getElementById('testPromptBtn').onclick=async()=>{
    try {
      await navigator.mediaDevices.getUserMedia({video:true});
      setStatus('Izin kamera OK - tekan Coba Lagi','ok');
    } catch(e2){ setStatus('Masih ditolak','err'); }
  };
}

// Simple scanning loop (re-added)
async function tick(){
  if(!scanning) return; requestAnimationFrame(tick);
  try {
    if(detector){
      const codes = await detector.detect(els.video);
      if(codes && codes.length){
        const raw = codes[0].rawValue || codes[0].rawData || '';
        const code = extractCode(raw);
        if(code) validate(code);
      }
    } else if(useFallback && window.jsQR && els.video.readyState===HTMLMediaElement.HAVE_ENOUGH_DATA){
      const vw=els.video.videoWidth, vh=els.video.videoHeight;
      if(vw && vh){
        if(!canvas){ canvas=document.createElement('canvas'); ctx=canvas.getContext('2d'); }
        canvas.width=vw; canvas.height=vh; ctx.drawImage(els.video,0,0,vw,vh);
        const imgData=ctx.getImageData(0,0,vw,vh);
        const codeObj=window.jsQR(imgData.data,vw,vh);
        if(codeObj && codeObj.data){ const extracted=extractCode(codeObj.data); if(extracted) validate(extracted); }
      }
    }
  } catch(e) { /* swallow frame errors */ }
}

// WebSocket message localization
function initGateWSIfToken(){
  const token = state.token || (function(){ try{ return JSON.parse(localStorage.getItem('gateAuth')).token }catch{ return null } })();
  if(token){
    const url = `wss://registrasi-unz-api.formsurveyhth.workers.dev/ws?token=${encodeURIComponent(token)}`;
    wsConnect(url, e => { try { const m=JSON.parse(e.data); if(m.code){
      let msg='';
      if(m.result==='USED') msg='Berhasil Registrasi';
      else if(m.error==='ALREADY_USED') msg='Telah Registrasi Sebelumnya';
      log(`${new Date().toLocaleTimeString()} WS ${m.code} ${msg}`,'used');
    } } catch{} });
  }
}

// UI Controls
els.toggleCamBtn?.addEventListener('click', async ()=>{
  if(state.paused){
    // Resume: reacquire camera
    state.paused=false;
    els.toggleCamBtn.textContent='Hentikan Kamera';
    setStatus('Mengaktifkan kamera...','warn');
    await startVideo();
    setStatus('Kamera aktif','ok');
    els.camState.textContent='ya';
    return;
  }
  // Pause: fully stop tracks & scanning loop
  state.paused=true;
  scanning=false;
  try { if(state.stream){ for(const t of state.stream.getTracks()) t.stop(); } } catch{}
  state.stream=null; detector=null; useFallback=false;
  els.video.srcObject=null;
  els.toggleCamBtn.textContent='Aktifkan Kamera';
  els.camState.textContent='tidak';
  setStatus('Kamera dimatikan','warn');
});

els.switchCamBtn?.addEventListener('click', async ()=>{
  if(state.paused){ setStatus('Aktifkan kamera dulu','warn'); return; }
  if(state.devices.length<2) { setStatus('Tidak ada kamera lain','warn'); return; }
  try {
    state.deviceIndex=(state.deviceIndex+1)%state.devices.length;
    if(state.stream){ for(const t of state.stream.getTracks()) t.stop(); }
    await startVideo();
    setStatus('Kamera diganti','ok');
  } catch(e){ setStatus('Gagal ganti kamera','err'); }
});

// Force reset camera button
els.forceResetCamBtn?.addEventListener('click', ()=>{ forceResetCamera(); });

els.clearLogBtn?.addEventListener('click', ()=>{ els.resultLog.innerHTML=''; els.logCount.textContent=''; });

// ===== Manual Input (simple) =====
function manualValidate(){
  const raw=(els.manualCode.value||'').trim();
  if(!raw) return;
  const code=extractCode(raw);
  validate(code);
}
els.validateBtn?.addEventListener('click', manualValidate);
els.manualCode?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); manualValidate(); }});

// ===== Logout =====
function logout(){
  stopVideoTracks();
  state.token=null; state.admin_id=null; state.role=null; state.currentCode=null; state.recentCodes.clear();
  try { localStorage.removeItem('gateAuth'); } catch{}
  // Reset UI
  els.scanner.classList.add('hidden');
  els.authSection.classList.remove('hidden');
  els.roleTag.classList.add('hidden');
  els.logoutBtn?.classList.add('hidden');
  setStatus('Logout','warn');
}
els.logoutBtn?.addEventListener('click', logout);

// Reveal logout once authenticated
if(state.token){ els.logoutBtn?.classList.remove('hidden'); }

// ===== Additional Mitigations & Diagnostics =====
// 1. Camera diagnostics: enumerate devices & permission state
const diagBtn = document.getElementById('diagCamBtn');
diagBtn?.addEventListener('click', async ()=>{
  const wrapId='camDiagPanel';
  let panel=document.getElementById(wrapId);
  if(panel){ panel.remove(); return; }
  panel=document.createElement('div');
  panel.id=wrapId;
  panel.style.cssText='margin-top:8px;font-size:.65rem;background:#1e252a;padding:8px 10px;border:1px solid #304049;border-radius:6px;line-height:1.3';
  panel.innerHTML='<strong style="font-size:.7rem;letter-spacing:.5px">Diagnostik Kamera</strong><div id="camDiagContent" style="margin-top:4px;opacity:.85">Memeriksa...</div>';
  els.scanner.appendChild(panel);
  try {
    const perm = navigator.permissions ? await navigator.permissions.query({name:'camera'}) : null;
    let permState = perm? perm.state : 'unknown';
    const list = await navigator.mediaDevices.enumerateDevices();
    const vids = list.filter(d=>d.kind==='videoinput');
    let txt = `Status Izin: ${permState}<br/>Jumlah Kamera: ${vids.length}<br/>`;
    if(!vids.length){ txt += 'Tidak ada perangkat video. Pastikan kamera tidak dipakai aplikasi lain.'; }
    else { txt += vids.map((v,i)=>`#${i+1}: ${v.label||'(label tersembunyi, izin belum diberikan)'} (${v.deviceId.slice(0,8)})`).join('<br/>'); }
    txt += '<br/><button id="forcePermBtn" style="margin-top:6px;background:#275c9b;color:#fff;border:0;padding:5px 8px;border-radius:4px;font-size:.65rem;cursor:pointer">Tes Prompt Izin</button>';
    txt += ' <button id="closeDiagBtn" style="margin-top:6px;background:#444;color:#fff;border:0;padding:5px 8px;border-radius:4px;font-size:.65rem;cursor:pointer">Tutup</button>';
    document.getElementById('camDiagContent').innerHTML=txt;
    document.getElementById('forcePermBtn').onclick=async()=>{
      try { await navigator.mediaDevices.getUserMedia({video:true}); setStatus('Izin OK','ok'); }catch{ setStatus('Masih ditolak','err'); }
    };
    document.getElementById('closeDiagBtn').onclick=()=>panel.remove();
  } catch(e){ document.getElementById('camDiagContent').textContent='Gagal memeriksa: '+e; }
});

// 2. Image upload fallback (operator dapat foto QR dari peserta)
const uploadQRBtn=document.getElementById('uploadQRBtn');
const qrFileInput=document.getElementById('qrFile');
uploadQRBtn?.addEventListener('click', ()=>{ qrFileInput.click(); });
qrFileInput?.addEventListener('change', async ()=>{
  const file=qrFileInput.files && qrFileInput.files[0];
  if(!file) return;
  if(!canvas){ canvas=document.createElement('canvas'); ctx=canvas.getContext('2d'); }
  const img=new Image();
  img.onload=()=>{
    canvas.width=img.width; canvas.height=img.height; ctx.drawImage(img,0,0);
    try {
      if(window.jsQR){
        const data=ctx.getImageData(0,0,canvas.width,canvas.height);
        const res=window.jsQR(data.data,canvas.width,canvas.height);
        if(res && res.data){ const extracted=extractCode(res.data); if(extracted) validate(extracted); else setStatus('QR tidak terbaca','err'); }
        else setStatus('QR tidak ditemukan','warn');
      } else {
        setStatus('jsQR belum siap','warn');
      }
    } catch(e){ setStatus('Gagal memproses gambar','err'); }
  };
  img.onerror=()=>setStatus('Gagal memuat gambar','err');
  const url=URL.createObjectURL(file); img.src=url;
});

