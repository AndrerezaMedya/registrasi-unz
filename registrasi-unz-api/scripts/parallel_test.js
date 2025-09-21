// Parallel mark-used test
const WORKER = process.env.WORKER;
const TOKEN = process.env.TOKEN;
const CODE = process.env.CODE || 'SAMPLE5';

if (!WORKER || !TOKEN) {
  console.error('Missing WORKER/TOKEN env');
  process.exit(1);
}

const body = { code: CODE, admin_id: 'gate1' };
const headers = {
  'content-type': 'application/json',
  'authorization': `Bearer ${TOKEN}`,
  'origin': 'https://registrasi-unz.web.app'
};

async function fire() {
  const r = await fetch(`${WORKER}/mark-used`, { method: 'POST', headers, body: JSON.stringify(body) });
  let text = await r.text().catch(()=> '');
  return { status: r.status, body: text.slice(0, 120) };
}

(async () => {
  const results = await Promise.all([fire(), fire(), fire()]);
  console.log(JSON.stringify(results, null, 2));
})();
