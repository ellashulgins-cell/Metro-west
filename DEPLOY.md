# Metro RP — карта: деплой на Vercel

## Структура проекта

| Файл | Назначение |
|------|------------|
| `Metro_RP_3D_Viewer.html` | Сам просмотрщик (27 МБ) |
| `middleware.js` | Vercel Edge — парольный gate |
| `api/version.js` | Endpoint версии пароля (polling) |
| `api/markers.js` | CRUD общих меток (GET за паролем сайта) |
| `api/admin.js` | Логин админа + смена пароля + reroute + аудит |
| `api/_utils.js` | Общие утилиты (auth-хелперы, IP-маска). `_` → Vercel не роутит |
| `__admin/index.html` | Панель администратора |
| `package.json` | Зависимости `@vercel/edge`, `@vercel/kv` |
| `vercel.json` | Rewrites, cache headers, noindex |
| `metrorp_q_underground_west.bsp` (129 МБ) | Карта — **на Cloudflare R2**, не в Git |
| `found_models/metro_props.bin` (253 МБ) | Модели — **на Cloudflare R2**, не в Git |

---

## Шаг 1. Большие файлы → Cloudflare R2 (бесплатно)

1. Cloudflare → R2 → создать бакет (напр. `metro-rp`).
2. Загрузить оба файла с **неугадываемыми именами**:
   - `map-8f3a9c2b71.bsp`
   - `props-5d7e1a90c4.bin`
3. Public access ON, скопировать домен `https://pub-xxxx.r2.dev`.
4. CORS: разрешить домен Vercel.

## Шаг 2. Прописать ссылки

В `Metro_RP_3D_Viewer.html` подставить свои R2-URL:
```js
const MAP_URL='https://pub-xxxx.r2.dev/map-8f3a9c2b71.bsp';
const PROPS_URL='https://pub-xxxx.r2.dev/props-5d7e1a90c4.bin';
```

## Шаг 3. Vercel: проект

1. Залить папку в Git-репозиторий (без больших файлов — они в `.gitignore`).
   - ⚠ `Metro_RP_3D_Viewer.html` весит ~27 МБ. GitHub web-редактор блокирует
     файлы > 25 МБ, но `git push` пропустит (лимит 100 МБ). Правки — **только
     локально через git**, не через сайт GitHub.
2. Vercel → Add New → Project → импорт репозитория. Framework: **Other**, build пустой.

## Шаг 4. Vercel: Environment Variables

| Name | Value | Назначение |
|------|-------|------------|
| `SITE_PASSWORD` | придумай | Стартовый пароль сайта (пока в KV пусто) |
| `ADMIN_PASSWORD` | придумай | Пароль для входа в админку |

Environments: Production, Preview.

## Шаг 5. Vercel KV

Vercel → проект → Storage → **Create Database → KV**. Подключить к проекту (Vercel сам добавит env `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`).

**Для чего KV:**
- `site_password` — текущий пароль сайта (можно менять без Redeploy)
- `pw_version` — счётчик смен пароля (клиент опрашивает и делает reload)
- `markers` — общие метки
- `reroute_points` — reroute-точки
- `admin_sessions:*` — opaque-токены админ-сессий
- `audit_log` — журнал последних 500 действий
- `rl:login:*` — rate-limit брутфорса

Без KV: пароль читается из env, метки/reroute/аудит не работают.

## Шаг 6. Deploy → готово

- Основной URL → экран пароля (значение `SITE_PASSWORD`).
- `/__admin` → экран входа админа (значение `ADMIN_PASSWORD`) → 4 вкладки:
  - **Пароль сайта**: смена без redeploy, все юзеры выкидываются за ~30 сек
  - **Метки**: добавить / переименовать / категория / удалить
  - **Reroute-точки**: одна или массовый импорт `getpos`-лога
  - **Аудит**: последние 200 событий с масками IP

## Смена пароля

Открой `/__admin` → **Пароль сайта** → введи новый → **Сменить**. Все текущие
пользователи автоматически перейдут на экран пароля в течение 30 сек (клиент
опрашивает `/api/version` и делает reload при инкременте счётчика).

Rate-limit: 8 попыток входа в минуту на IP.

## Reroute-точки для правильного маршрута

Если строгий маршрут между двумя базами не работает / идёт не через тот
проход, добавь reroute-точки:

1. GMod: `bind KEY "getpos"` в консоли.
2. Пройди маршрут ногами, жми клавишу каждые 2-3 сек.
3. Скопируй вывод (много строк `setpos ...`).
4. Админка → **Reroute-точки** → «Массовый импорт» → вставь → **Импортировать**.

Клиенты подхватят точки при следующей загрузке; A* пойдёт через них.

## Локальная проверка без Vercel

Открой `Metro_RP_3D_Viewer.html` через `python -m http.server 8973` в этой
папке — работает встроенный экран пароля (легаси-фолбэк). Админка и общие
метки локально не работают (нужен Vercel + KV).

Dev-режим UI: `?dev=1` в URL — покажет служебные кнопки/чекбоксы (`.dev-only`).
