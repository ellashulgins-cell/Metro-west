// /api/markers — общие («системные») метки на карте.
//   GET  — пользователю сайта (mrp_auth) или админу
//   POST — только admin (KV-сессия)
//   DELETE — только admin
export const config = { runtime: 'edge' };

import { getKv, jsonResp, audit, ipMasked, isSiteAuthed, isAdminSession } from './_utils.js';

async function readAll(kv){
  try{ const arr = await kv.get('markers'); return Array.isArray(arr) ? arr : []; }
  catch(e){ return [] }
}
async function writeAll(kv, arr){ await kv.set('markers', arr); }

export default async function handler(request){
  const method = request.method;
  const url = new URL(request.url);
  const kv = await getKv();

  if(method === 'GET'){
    const okSite = await isSiteAuthed(request, kv);
    const okAdmin = okSite ? false : await isAdminSession(request, kv);
    if(!okSite && !okAdmin) return jsonResp({error:'auth required'}, 401);
    if(!kv) return jsonResp({ markers: [] });
    return jsonResp({ markers: await readAll(kv) });
  }

  if(!(await isAdminSession(request, kv))) return jsonResp({ error: 'admin required' }, 401);
  if(!kv) return jsonResp({ error: 'KV недоступен' }, 500);
  const ip = ipMasked(request);

  if(method === 'POST'){
    let body;
    try{ body = await request.json() }catch(e){ return jsonResp({error:'bad json'}, 400) }
    if(!body || typeof body !== 'object') return jsonResp({error:'bad payload'}, 400);

    // Поддержка массового сидирования баз/переходов
    if(Array.isArray(body.seedBatch)){
      const arr = await readAll(kv);
      let changed = false;
      for(const sb of body.seedBatch){
        if(!sb.id || !sb.name || !sb.category) continue;
        if(!arr.some(m => m.id === sb.id || m.name === sb.name)){
          arr.push({
            id: String(sb.id),
            name: String(sb.name).slice(0, 80),
            category: String(sb.category).slice(0, 40),
            x: Number(sb.x), y: Number(sb.y), z: Number(sb.z),
            note: '',
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
          changed = true;
        }
      }
      if(changed) await writeAll(kv, arr);
      return jsonResp({ ok: true, markers: arr });
    }

    const id = String(body.id || Math.random().toString(36).slice(2, 12));
    const name = String(body.name || '').slice(0, 80);
    const category = String(body.category || 'loot').slice(0, 40).trim().toLowerCase() || 'loot';
    const x = Number(body.x), y = Number(body.y), z = Number(body.z);
    const note = String(body.note || '').slice(0, 200);
    if(!name || !isFinite(x) || !isFinite(y) || !isFinite(z))
      return jsonResp({error:'name/x/y/z required'}, 400);
    const arr = await readAll(kv);
    const idx = arr.findIndex(m => m.id === id);
    const now = Date.now();
    const rec = idx >= 0
      ? { ...arr[idx], name, category, x, y, z, note, updatedAt: now }
      : { id, name, category, x, y, z, note, createdAt: now, updatedAt: now };
    if(idx >= 0) arr[idx] = rec; else arr.push(rec);
    await writeAll(kv, arr);
    await audit(kv, idx >= 0 ? 'marker_updated' : 'marker_added', { ip, id, name, category });
    return jsonResp({ ok: true, marker: rec });
  }

  if(method === 'DELETE'){
    const id = url.searchParams.get('id');
    if(!id) return jsonResp({error:'id required'}, 400);
    const arr = await readAll(kv);
    const target = arr.find(m => m.id === id);
    const next = arr.filter(m => m.id !== id);
    await writeAll(kv, next);
    await audit(kv, 'marker_removed', { ip, id, name: target?.name || '' });
    return jsonResp({ ok: true, removed: arr.length - next.length });
  }

  return jsonResp({error:'method not allowed'}, 405);
}
