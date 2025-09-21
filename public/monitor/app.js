const WORKER_URL='https://registrasi-unz-api.formsurveyhth.workers.dev';
const els={loginForm:document.getElementById('loginForm'),status:document.getElementById('status'),feed:document.getElementById('feed'),authInfo:document.getElementById('authInfo'),wsStatus:document.getElementById('ws-status')};
const state={token:null,admin_id:null,ws:null};

function setStatus(t,c){els.status.textContent=t;els.status.className='status '+(c||'');els.status.classList.add('flash');setTimeout(()=>els.status.classList.remove('flash'),400);}
function log(msg,ok=true){const d=document.createElement('div');d.textContent=msg;d.className= ok?'ok':'err';els.feed.prepend(d);} // basic
function saveAuth(data){state.token=data.token;state.admin_id=data.admin_id;localStorage.setItem('monitorAuth',JSON.stringify({token:data.token,admin_id:data.admin_id}));}
function loadAuth(){try{const j=JSON.parse(localStorage.getItem('monitorAuth'));if(j&&j.token){state.token=j.token;state.admin_id=j.admin_id;return true}}catch{}return false;}

async function login(u,p){const r=await fetch(WORKER_URL+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const j=await r.json();if(j.ok){saveAuth(j);els.loginForm.style.display='none';els.authInfo.textContent=`Masuk sebagai ${u}`;openWS();setStatus('Login berhasil','ok');}else{setStatus(j.error||'Login gagal','err');}}

els.loginForm.addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(els.loginForm);login(fd.get('username'),fd.get('password'));});

if(loadAuth()){els.loginForm.style.display='none';els.authInfo.textContent='Sesi dipulihkan';openWS();}

function openWS(){
	if(!state.token) return;
	if(state.ws){ try{ state.ws.close(); }catch{} }
	const url=WORKER_URL.replace('https://','wss://')+`/ws?token=${encodeURIComponent(state.token)}`;
	let retry=0; const maxDelay=30000;
	const connect=()=>{
		els.wsStatus.textContent = 'menghubungkan';
		const ws=new WebSocket(url); state.ws=ws;
		ws.onopen=()=>{ retry=0; els.wsStatus.textContent='terhubung'; setStatus('WS terhubung','ok'); };
		let lastPong=Date.now();
		const hbInterval=setInterval(()=>{
			if(ws.readyState===WebSocket.OPEN){
				try{ ws.send('ping'); }catch{}
				if(Date.now()-lastPong>45000){ try{ ws.close(); }catch{} }
			}
		},20000);
		ws.onclose=()=>{ clearInterval(hbInterval); els.wsStatus.textContent='menyambung ulang'; const delay=Math.min(1000 * 2**retry++, maxDelay); setTimeout(connect, delay); };
		ws.onerror=()=>{ try{ ws.close(); }catch{} };
		ws.onmessage=e=>{
			try {
				if(e.data==='pong'){ lastPong=Date.now(); return; }
				const m=JSON.parse(e.data);
				if(m.type==='snapshot' && Array.isArray(m.events)){
					log(`--- snapshot ${m.events.length} event ---`);
					for(const ev of m.events.slice().reverse()){
						if(ev.code){ const when=ev.used_at?new Date(ev.used_at).toLocaleTimeString():'-'; const msg = ev.result==='USED' ? 'Berhasil Registrasi' : (ev.error==='ALREADY_USED' ? 'Telah Registrasi Sebelumnya' : (ev.result||ev.error||'')); log(`${when} ${ev.code} ${ev.name||''} ${msg}`, ev.result==='USED'); }
					}
					return;
				}
				if(m.code){
					const when=m.used_at?new Date(m.used_at).toLocaleTimeString():'-';
					const msg = m.result==='USED' ? 'Berhasil Registrasi' : (m.error==='ALREADY_USED' ? 'Telah Registrasi Sebelumnya' : (m.result||m.error||''));
					log(`${when} ${m.code} ${m.name||''} ${msg}`, m.result==='USED');
				}
			} catch {}
		};
	};
	connect();
}
