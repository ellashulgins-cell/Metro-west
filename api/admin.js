// /api/admin — вход, смена пароля сайта, аудит-лог, reroute-точки.
//   POST /api/admin?action=login    body: {password}
//   POST /api/admin?action=logout
//   POST /api/admin?action=setpwd   body: {newPassword}
//   GET  /api/admin?action=audit
//   GET  /api/admin?action=reroute  — требует mrp_auth или admin
//   POST /api/admin?action=reroute  body: {name?, x, y, z} | {points:[...]}
//   DELETE /api/admin?action=reroute&id=...
//
// Rate-limit: 8 попыток логина в минуту на IP.
// Admin cookie = 32-байтовый opaque token, сессия хранится в KV.
export const config = { runtime: 'edge' };

import { ADMIN_COOKIE, ADMIN_TTL_SECONDS, getKv, getCookie, jsonResp, audit, ipMasked, ipRaw, newSessionToken, isAdminSession, isSiteAuthed } from './_utils.js';

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW = 60;

async function checkRateLimit(kv, ip){
  if(!kv) return { ok: true, remaining: LOGIN_LIMIT };
  try{
    const key = 'rl:login:' + ip;
    const n = await kv.incr(key);
    if(n === 1) await kv.expire(key, LOGIN_WINDOW);
    return { ok: n <= LOGIN_LIMIT, remaining: Math.max(0, LOGIN_LIMIT - n) };
  }catch(e){ return { ok: true, remaining: LOGIN_LIMIT }; }
}

function safeEqual(a, b){
  if(a.length !== b.length) return false;
  let d = 0; for(let i=0;i<a.length;i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default async function handler(request){
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const kv = await getKv();

  if(request.method === 'POST' && action === 'login'){
    const ip = ipMasked(request);
    const rlIp = ipRaw(request);
    const rl = await checkRateLimit(kv, rlIp);
    if(!rl.ok){
      await audit(kv, 'login_ratelimited', { ip });
      return jsonResp({ error: 'Слишком много попыток. Подожди минуту.' }, 429);
    }
    let body; try{ body = await request.json() }catch(e){ body = {} }
    const password = String((body && body.password) || '');
    const want = process.env.ADMIN_PASSWORD || '';
    if(!want) return jsonResp({error:'ADMIN_PASSWORD не задан'}, 500);
    if(!safeEqual(password, want)){
      await audit(kv, 'login_failed', { ip });
      return jsonResp({error:'invalid', remaining: rl.remaining - 1}, 401);
    }
    if(!kv) return jsonResp({error:'KV недоступен'}, 500);
    const token = newSessionToken();
    try{ await kv.set('as:' + token, '1', { ex: ADMIN_TTL_SECONDS }); }
    catch(e){ return jsonResp({error:'не удалось создать сессию'}, 500); }
    await audit(kv, 'login_ok', { ip });
    const secure = url.protocol === 'https:';
    const cookie = `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ADMIN_TTL_SECONDS}` + (secure ? '; Secure' : '');
    return jsonResp({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if(request.method === 'POST' && action === 'logout'){
    const tok = getCookie(request, ADMIN_COOKIE);
    if(tok && kv){ try{ await kv.del('as:' + tok); }catch(e){} }
    return jsonResp({ ok: true }, 200, { 'set-cookie': `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
  }

  if(request.method === 'GET' && action === 'reroute'){
    const okSite = await isSiteAuthed(request, kv);
    const okAdmin = okSite ? false : await isAdminSession(request, kv);
    if(!okSite && !okAdmin) return jsonResp({error:'auth required'}, 401);
    if(!kv) return jsonResp({ points: [] });
    const raw = await kv.get('reroute_points');
    return jsonResp({ points: Array.isArray(raw) ? raw : [] });
  }

  if(!(await isAdminSession(request, kv))) return jsonResp({error:'admin required'}, 401);
  const ip = ipMasked(request);

  if(request.method === 'POST' && action === 'setpwd'){
    let body; try{ body = await request.json() }catch(e){ body = {} }
    const newPassword = String((body && body.newPassword) || '').trim();
    if(newPassword.length < 4) return jsonResp({error:'пароль слишком короткий'}, 400);
    if(!kv) return jsonResp({error:'KV недоступен'}, 500);
    await kv.set('site_password', newPassword);
    const v = Number(await kv.get('pw_version')) || 0;
    await kv.set('pw_version', v + 1);
    await audit(kv, 'password_changed', { ip, version: v + 1 });
    return jsonResp({ ok: true, version: v + 1 });
  }

  if(request.method === 'GET' && action === 'audit'){
    if(!kv) return jsonResp({ log: [] });
    const raw = await kv.lrange('audit_log', 0, 199);
    const log = raw.map(x => { try{ return typeof x === 'string' ? JSON.parse(x) : x }catch(e){ return null } }).filter(Boolean);
    return jsonResp({ log });
  }

  if(action === 'reroute'){
    if(!kv) return jsonResp({error:'KV недоступен'}, 500);
    if(request.method === 'POST'){
      let body; try{ body = await request.json() }catch(e){ body = {} }
      const list = (await kv.get('reroute_points')) || [];
      const arr = Array.isArray(list) ? list.slice() : [];
      const now = Date.now();
      const isBulk = Array.isArray(body.points);
      const trackId = 't' + now + '_' + Math.floor(Math.random()*1e6);
      const push = (p) => {
        const x = Number(p.x), y = Number(p.y), z = Number(p.z);
        if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
        arr.push({
          id: 'r' + now + '_' + Math.floor(Math.random()*1e6),
          trackId: isBulk ? trackId : ('single_' + Math.floor(Math.random()*1e9)),
          name: String(p.name||'').slice(0,60),
          note: String(p.note||'').slice(0,200),
          x, y, z,
          createdAt: now
        });
        return true;
      };
      let added = 0;
      if(isBulk){ for(const p of body.points) if(push(p)) added++; }
      else if(push(body)) added = 1;
      await kv.set('reroute_points', arr);
      await audit(kv, 'reroute_added', { ip, count: added, trackId: isBulk ? trackId : null });
      return jsonResp({ ok: true, added, total: arr.length });
    }
    if(request.method === 'DELETE'){
      const list = (await kv.get('reroute_points')) || [];
      const arrIn = Array.isArray(list) ? list : [];
      // ?all=1 — снести всё разом.
      if(url.searchParams.get('all') === '1'){
        const removed = arrIn.length;
        await kv.set('reroute_points', []);
        await audit(kv, 'reroute_cleared', { ip, removed });
        return jsonResp({ ok: true, removed, total: 0 });
      }
      // ?ids=a,b,c — удалить конкретный список.
      const idsParam = url.searchParams.get('ids');
      if(idsParam){
        const idSet = new Set(idsParam.split(',').filter(Boolean));
        const arr = arrIn.filter(p => !idSet.has(p.id));
        const removed = arrIn.length - arr.length;
        await kv.set('reroute_points', arr);
        await audit(kv, 'reroute_removed_many', { ip, removed });
        return jsonResp({ ok: true, removed, total: arr.length });
      }
      // Одиночное удаление по id (обратная совместимость).
      const id = url.searchParams.get('id');
      const arr = arrIn.filter(p => p.id !== id);
      await kv.set('reroute_points', arr);
      await audit(kv, 'reroute_removed', { ip, id });
      return jsonResp({ ok: true, total: arr.length });
    }
  }

  return jsonResp({error:'unknown action'}, 400);
}
