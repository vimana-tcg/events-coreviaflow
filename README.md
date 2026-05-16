# events.coreviaflow.space

Meta Conversions API (CAPI) проксі-сервер. Приймає події з лендингу, CRM, і Monobank webhook, нормалізує, додає server-side дані (IP, UA), хешує PII, і пушить у Meta з підтримкою дедуплікації з браузерним Pixel.

## Чому окремий сервіс

- Не зачіпає CRM (Next.js на Vercel) — ризик ламки нуль.
- Окремий деплой, окремий лог.
- Малий footprint: один Node-процес, ~30 MB RAM.

## Endpoints

| Метод | Шлях | Хто кличе | Опис |
|---|---|---|---|
| GET | `/healthz` | Coolify | Healthcheck |
| GET | `/v1/status` | Адмін | Стан сервісу (без даних) |
| POST | `/v1/track` | Лендинг або сервер | Одна подія |
| POST | `/v1/track-batch` | Тільки сервер (з secret) | Кілька подій разом |

## Деплой через Coolify

1. **GitHub repo:** створи окремий `events-coreviaflow` репо, push цей код туди.
2. **Coolify → New Service → Public Repository** → вкажи URL.
3. **Build type:** Dockerfile (вже в репо).
4. **Domain:** `events.coreviaflow.space` (DNS A-запис на VPS).
5. **Environment variables** з `.env.example`.
6. Deploy.

Перевірка: `curl https://events.coreviaflow.space/healthz` → `{"ok":true,...}`.

## Тест перед продом — Test Events

1. У Events Manager → твій Pixel → **Test Events**.
2. Скопіюй **Test Event Code** (тимчасовий, ~`TEST12345`).
3. Постав у `META_TEST_EVENT_CODE` на VPS.
4. Відкрий лендинг → події з'являться в Test Events в реальному часі.
5. Як побачив `PageView`, `InitiateCheckout`, `Purchase` — приберай `META_TEST_EVENT_CODE` (порожній рядок). Тоді події підуть у production-стрим.

## Інтеграція з Monobank webhook

CRM приймає webhook від Monobank про оплату. Після того як упевнились що оплата успішна, додай в існуючий обробник:

```js
// app/api/monobank/webhook/route.ts (або де приймаєш Monobank webhook)
async function pushPurchaseToCAPI(order) {
  await fetch('https://events.coreviaflow.space/v1/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-events-secret': process.env.EVENTS_SECRET,
    },
    body: JSON.stringify({
      event_name: 'Purchase',
      event_id: order.id, // унікальний — для дедуплікації з пікселем
      event_time: Math.floor(new Date(order.paidAt).getTime() / 1000),
      event_source_url: 'https://olx.coreviaflow.space/thanks',
      action_source: 'website',
      email: order.customerEmail,
      phone: order.customerPhone,
      fbp: order.fbp, // якщо зберігав з лендингу
      fbc: order.fbc,
      custom_data: {
        value: order.amount,
        currency: order.currency || 'USD',
        content_name: 'OLX Autopilot — ' + order.tier,
        order_id: order.id,
      },
    }),
  });
}
```

**Чому це важливо:** браузерний Pixel пропускає 20-40% подій через iOS 14+, ad-blockers, повторні відвідування з закритими cookie. Server-side CAPI рятує ці події і ROAS-розрахунки в Meta стають точнішими.

## Архітектура подій (3 джерела)

```
┌─────────────────┐   PageView, InitiateCheckout, Purchase   ┌─────────────┐
│   Лендинг       │ ─────────────────────────────────────────▶│             │
│ Pixel JS        │           (з event_id для дедупу)         │             │
└─────────────────┘                                            │             │
                                                                │   META      │
┌─────────────────┐   Purchase (з реальними даними платежу)   │   CAPI      │
│ Monobank        │ ─▶ events.coreviaflow.space ─────────────▶│  /events    │
│ webhook → CRM   │   x-events-secret = шарений ключ          │             │
└─────────────────┘                                            │             │
                                                                │             │
┌─────────────────┐   InitiateCheckout (коли скидаємо рекв.)  │             │
│ Daryna / Anna   │ ─▶ events.coreviaflow.space ─────────────▶│             │
│ (Telegram bot)  │                                            └─────────────┘
└─────────────────┘
```

Meta робить дедуплікацію через `event_id` — якщо однакова подія прийшла з пікселя і з CAPI, рахується одна. Якщо одна впала з пікселя, друга з CAPI — вийде одна.

## Безпека

- PII (email/phone) хешується SHA-256 перед відправкою (вимога Meta).
- Server-to-server endpoints вимагають `x-events-secret` header.
- CORS обмежений до наших лендингів.
- Token у env — не в коді.
- `npm install --omit=dev` у Docker — без dev залежностей.

## Локальний тест

```bash
cp .env.example .env
# заповни FACEBOOK_CAPI_TOKEN, EVENTS_SECRET
npm install
npm run dev
# в другому терміналі:
curl -X POST http://localhost:8080/v1/track \
  -H "Content-Type: application/json" \
  -d '{"event_name":"PageView","event_source_url":"http://localhost/test"}'
```
