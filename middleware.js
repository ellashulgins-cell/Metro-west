// ============================================================================
//  СЕРВЕРНАЯ ЗАЩИТА  (Vercel Edge Middleware)
// ----------------------------------------------------------------------------
//  Без правильного пароля сервер не отдаёт ни страницу, ни файлы.
//  Пароль хранится в Vercel KV (site_password) с fallback на env SITE_PASSWORD.
//  Смена пароля инвалидирует все cookie (подпись HMAC от пароля).
//  Дополнительно pw_version инкрементируется — клиент опрашивает /api/version
//  раз в 30 сек и делает reload при смене.
//  /api/*, /__admin/*, favicon, robots — исключены из матчера.
// ============================================================================
import { next } from '@vercel/edge';

export const config = { matcher: '/((?!favicon\\.ico|robots\\.txt|api/|__admin).*)' };

const COOKIE = 'mrp_auth';
const TTL_SECONDS = 60 * 60 * 12; // 12 часов

const enc = new TextEncoder();
function toHex(buf){ let s=''; const b=new Uint8Array(buf); for(let i=0;i<b.length;i++) s+=b[i].toString(16).padStart(2,'0'); return s; }
async function sign(msg, key){
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
async function makeToken(pass){
  const exp = Math.floor(Date.now()/1000) + TTL_SECONDS;
  return exp + '.' + await sign(String(exp), pass);
}
async function validToken(tok, pass){
  if(!tok) return false;
  const i = tok.indexOf('.');
  if(i < 1) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if(!/^\d+$/.test(exp) || (+exp) < Math.floor(Date.now()/1000)) return false;
  const want = await sign(exp, pass);
  if(sig.length !== want.length) return false;
  let d = 0; for(let j=0;j<sig.length;j++) d |= sig.charCodeAt(j) ^ want.charCodeAt(j);
  return d === 0;
}
function getCookie(request, name){
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function getSitePassword(){
  try{
    const { kv } = await import('@vercel/kv');
    const p = await kv.get('site_password');
    if(p && typeof p === 'string' && p.length > 0) return p;
  }catch(e){}
  return process.env.SITE_PASSWORD || null;
}

// Заголовки безопасности для собственных ответов middleware (страница пароля,
// редирект, 429). Статику (карта/админка/api) покрывает блок headers в vercel.json.
const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
};

// Rate-limit на ввод пароля сайта (по образцу admin-логина): 12 попыток/мин на IP.
async function checkAuthRateLimit(request){
  try{
    const ip = (request.headers.get('x-forwarded-for')||'').split(',')[0].trim()
             || request.headers.get('x-real-ip') || 'unknown';
    const { kv } = await import('@vercel/kv');
    const key = 'rl:site:' + ip;
    const n = await kv.incr(key);
    if(n === 1) await kv.expire(key, 60);
    return n <= 12;
  }catch(e){ return true; } // KV недоступен — не блокируем вход
}

function loginResponse(errText){
  const err = errText ? String(errText).replace(/</g,'&lt;') : '';
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Metro RP West</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23800000'/%3E%3Ctext x='50' y='75' font-size='70' font-weight='bold' text-anchor='middle' fill='%23000' font-family='sans-serif'%3EM%3C/text%3E%3C/svg%3E">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#111,#1c1b18 50%,#2e2c26);font-family:system-ui,sans-serif;color:#fff}
.b{border:2px solid #555248;border-radius:16px;padding:44px 52px;text-align:center;background:rgba(255,255,255,.02);backdrop-filter:blur(10px)}
h1{font-size:22px;margin-bottom:8px;background:linear-gradient(135deg,#f60,#f85);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#889;font-size:13px;margin-bottom:22px}
input{padding:11px 16px;border:1px solid #444;border-radius:8px;background:#1a1a1e;color:#fff;font-size:15px;text-align:center;width:240px;outline:none;letter-spacing:2px}
input:focus{border-color:#f60}
button{margin-top:16px;display:block;width:100%;padding:11px;background:linear-gradient(135deg,#f60,#e55);color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600}
button:hover{transform:scale(1.02)}
.e{color:#e55;font-size:12px;min-height:16px;margin-top:12px}</style></head>
<body><form class="b" method="POST" action="/__auth" autocomplete="off">
<h1>Metro RP West</h1><p>Введите пароль доступа</p>
<input type="password" name="password" placeholder="Пароль" autofocus>
<button type="submit">Войти</button>
<div class="e">${err}</div></form></body></html>`;
  return new Response(html, { status: errText ? 401 : 200, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', ...SEC_HEADERS } });
}

export default async function middleware(request){
  const pass = await getSitePassword();
  const url = new URL(request.url);

  if(!pass){
    return new Response('SITE_PASSWORD не задан. Заполните env-переменную проекта или site_password в Vercel KV.', { status: 500, headers: { 'content-type':'text/plain; charset=utf-8' } });
  }

  if(url.pathname === '/__auth' && request.method === 'POST'){
    if(!(await checkAuthRateLimit(request))){
      return new Response('Слишком много попыток. Подожди минуту.', { status: 429, headers: { 'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store', ...SEC_HEADERS } });
    }
    let entered = '';
    try { const form = await request.formData(); entered = String(form.get('password') || ''); } catch(e) {}
    if(entered === pass){
      const token = await makeToken(pass);
      const secure = url.protocol === 'https:';
      const attr = `Path=/; SameSite=Lax; Max-Age=${TTL_SECONDS}` + (secure ? '; Secure' : '');
      const h = new Headers();
      h.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; ${attr}`);
      h.append('Set-Cookie', `site_auth=1; ${attr}`);
      h.set('Location', '/');
      h.set('cache-control', 'no-store');
      for(const [k,v] of Object.entries(SEC_HEADERS)) h.set(k, v);
      return new Response(null, { status: 303, headers: h });
    }
    return loginResponse('Неверный пароль');
  }

  const tok = getCookie(request, COOKIE);
  if(await validToken(tok, pass)) return next();

  return loginResponse('');
}
