// Общие утилиты для edge-endpoint'ов. Vercel не роутит файлы с '_' в начале.
export const ADMIN_COOKIE = 'admin_auth';
export const SITE_COOKIE = 'mrp_auth';
export const ADMIN_TTL_SECONDS = 60 * 60 * 4; // 4 часа

const enc = new TextEncoder();
function toHex(buf){ let s=''; const b=new Uint8Array(buf); for(let i=0;i<b.length;i++) s+=b[i].toString(16).padStart(2,'0'); return s; }
async function _hmac(msg, key){
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export function getCookie(request, name){
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getKv(){
  try{ const m = await import('@vercel/kv'); return m.kv; }catch(e){ return null; }
}

export async function getSitePassword(kv){
  try{
    if(!kv){ const m = await import('@vercel/kv'); kv = m.kv; }
    const p = await kv.get('site_password');
    if(p && typeof p === 'string' && p.length > 0) return p;
  }catch(e){}
  return process.env.SITE_PASSWORD || null;
}

export async function isSiteAuthed(request, kv){
  const tok = getCookie(request, SITE_COOKIE);
  if(!tok) return false;
  const i = tok.indexOf('.');
  if(i < 1) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if(!/^\d+$/.test(exp) || (+exp) < Math.floor(Date.now()/1000)) return false;
  const pass = await getSitePassword(kv);
  if(!pass) return false;
  const want = await _hmac(exp, pass);
  if(sig.length !== want.length) return false;
  let d = 0; for(let j=0;j<sig.length;j++) d |= sig.charCodeAt(j) ^ want.charCodeAt(j);
  return d === 0;
}

export function newSessionToken(){
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export async function isAdminSession(request, kv){
  if(!kv) return false;
  const tok = getCookie(request, ADMIN_COOKIE);
  if(!tok || tok.length !== 64 || !/^[0-9a-f]+$/.test(tok)) return false;
  try{
    const v = await kv.get('as:' + tok);
    return v === '1' || v === 1 || v === true;
  }catch(e){ return false }
}

function _maskIp(ip){
  if(!ip || ip === 'unknown') return ip;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if(v4) return `${v4[1]}.${v4[2]}.${v4[3]}.*`;
  if(ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':****';
  return ip;
}
export function ipRaw(request){
  return (request.headers.get('x-forwarded-for')||'').split(',')[0].trim()
      || request.headers.get('x-real-ip') || 'unknown';
}
export function ipMasked(request){ return _maskIp(ipRaw(request)); }

export function jsonResp(obj, status=200, extraHeaders={}){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store', ...extraHeaders }
  });
}

export async function audit(kv, event, meta){
  if(!kv) return;
  try{
    await kv.lpush('audit_log', JSON.stringify({ t: Date.now(), event, ...meta }));
    await kv.ltrim('audit_log', 0, 499);
  }catch(e){}
}
