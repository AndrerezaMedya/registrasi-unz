// Rate limit burst test
const WORKER = process.env.WORKER;
const TOKEN = process.env.TOKEN;
const CODE = process.env.CODE || 'SAMPLE3'; // should already be USED to produce conflicts & push limiter

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
  return r.status;
}

(async () => {
  const promises = Array.from({ length: 8 }, fire);
  const statuses = await Promise.all(promises);
  console.log('statuses:', statuses.join(','));
  console.log('has429:', statuses.includes(429));
})();
