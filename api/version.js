// GET /api/version -> { v: <int> }
// Клиент опрашивает раз в 30 сек. При смене v делает location.reload().
// Публичный (без пароля) — polling не должен требовать сессии.
export const config = { runtime: 'edge' };

export default async function handler(){
  let v = 0;
  try{
    const { kv } = await import('@vercel/kv');
    const raw = await kv.get('pw_version');
    v = Number(raw) || 0;
  }catch(e){ v = 0 }
  return new Response(JSON.stringify({ v }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
