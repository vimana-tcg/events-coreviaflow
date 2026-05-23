'use strict';
/**
 * events.coreviaflow.space — Meta Conversions API (CAPI) proxy.
 *
 * Приймає події з трьох джерел:
 *   1. Landing (olx.coreviaflow.space) — Pixel JS дублює сюди події PageView,
 *      InitiateCheckout, Purchase.
 *   2. Monobank webhook — після успішної оплати CRM/Daryna postить сюди подію
 *      Purchase з реальними даними (value, currency, email).
 *   3. Daryna / Anna — при подачі реквізитів клієнту фіксуємо InitiateCheckout.
 *
 * Endpoint:
 *   POST /v1/track  — мейн ендпоінт
 *   GET  /healthz   — для Coolify healthcheck
 *
 * Дедуплікація:
 *   Pixel JS + CAPI відправляють однакову event_id. Meta merge'ить, не множить.
 *
 * Безпека:
 *   - PII (email/phone) хешується SHA-256 перед відправкою — вимога Meta.
 *   - IP клієнта береться з X-Forwarded-For (Coolify проксує).
 *   - User-Agent з заголовка.
 *   - HMAC підпис для server-to-server (Monobank → CAPI) — щоб ніхто чужий
 *     не флудив події. Header: x-events-secret.
 */

const express = require('express');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 8080;
const PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '1485718672417519';
const ACCESS_TOKEN = process.env.FACEBOOK_CAPI_TOKEN; // system user token з ads_management
const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const EVENTS_SECRET = process.env.EVENTS_SECRET || ''; // shared secret для server-to-server
const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || ''; // встановити поки тестуємо

// ── Multi-pixel: кожен сайт шле свій pixel_id. courses → старий, sl-claw → новий.
// Мапа pixel_id → token. Якщо для pixel свого токена нема — fallback на ACCESS_TOKEN.
// SLCLAW_PIXEL_ID / SLCLAW_CAPI_TOKEN — для sl-claw.tech (окремий pixel).
const SLCLAW_PIXEL_ID = process.env.SLCLAW_PIXEL_ID || '1303860444646281';
const SLCLAW_CAPI_TOKEN = process.env.SLCLAW_CAPI_TOKEN || '';
const PIXEL_TOKENS = { [PIXEL_ID]: ACCESS_TOKEN };
if (SLCLAW_PIXEL_ID && SLCLAW_CAPI_TOKEN) PIXEL_TOKENS[SLCLAW_PIXEL_ID] = SLCLAW_CAPI_TOKEN;
const ALLOWED_PIXELS = Object.keys(PIXEL_TOKENS);

// Резолвимо pixel + token із запиту. Невідомий pixel → дефолтний (старий).
function resolvePixel(reqPixelId) {
  const pid = reqPixelId && ALLOWED_PIXELS.includes(String(reqPixelId)) ? String(reqPixelId) : PIXEL_ID;
  return { pixelId: pid, token: PIXEL_TOKENS[pid] || ACCESS_TOKEN };
}

if (!ACCESS_TOKEN) {
  console.error('FATAL: FACEBOOK_CAPI_TOKEN не встановлено');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS — дозволяємо тільки наші лендинги
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allow = [
    'https://sl-claw.tech',
    'https://www.sl-claw.tech',
    'https://pay.sl-claw.tech',
    'https://courses.coreviaflow.space',
    'https://olx.coreviaflow.space',
    'https://crm.coreviaflow.space',
    'https://olx-autopilot.com.ua',
  ];
  if (allow.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-events-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function sha256Lower(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return xff || req.socket.remoteAddress || undefined;
}

// Hash PII перед відправкою — вимога Meta CAPI.
function buildUserData(req, body) {
  const ud = {};
  if (body.email) ud.em = [sha256Lower(body.email)];
  if (body.phone) ud.ph = [sha256Lower(body.phone.replace(/\D/g, ''))];
  if (body.first_name) ud.fn = [sha256Lower(body.first_name)];
  if (body.last_name) ud.ln = [sha256Lower(body.last_name)];
  if (body.country) ud.country = [sha256Lower(body.country)];
  if (body.city) ud.ct = [sha256Lower(body.city)];
  if (body.fbp) ud.fbp = body.fbp;
  if (body.fbc) ud.fbc = body.fbc;
  ud.client_ip_address = clientIp(req);
  ud.client_user_agent = req.headers['user-agent'] || undefined;
  return ud;
}

async function pushToMeta(events, pixelId, token) {
  const pid = pixelId || PIXEL_ID;
  const tok = token || ACCESS_TOKEN;
  const url = `https://graph.facebook.com/${API_VERSION}/${pid}/events`;
  const payload = { data: events };
  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;
  payload.access_token = tok;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const err = parsed?.error || {};
    throw new Error(`Meta CAPI ${res.status}: ${err.message || text.slice(0, 300)}`);
  }
  return parsed;
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, pixel: PIXEL_ID, ts: Date.now() });
});

// Опційний admin-endpoint щоб подивитись стан без публічних даних.
app.get('/v1/status', (req, res) => {
  res.json({
    ok: true,
    pixel_id: PIXEL_ID,
    has_token: Boolean(ACCESS_TOKEN),
    test_event_code: TEST_EVENT_CODE || null,
    api_version: API_VERSION,
  });
});

app.post('/v1/track', async (req, res) => {
  try {
    const body = req.body || {};

    // Якщо подія прийшла з нашого backend (server-to-server) — перевіряємо secret.
    // Браузерні події (з лендингу) не мають цей header — їх просто пропускаємо.
    const fromServer = req.headers['x-events-secret'];
    if (fromServer && EVENTS_SECRET && fromServer !== EVENTS_SECRET) {
      return res.status(401).json({ error: 'invalid secret' });
    }

    if (!body.event_name) return res.status(400).json({ error: 'event_name required' });

    const event = {
      event_name: body.event_name,
      event_time: body.event_time || Math.floor(Date.now() / 1000),
      event_id: body.event_id, // для дедуплікації з пікселем
      event_source_url: body.event_source_url,
      action_source: body.action_source || (fromServer ? 'system_generated' : 'website'),
      user_data: buildUserData(req, body),
      custom_data: body.custom_data || {},
    };

    const { pixelId, token } = resolvePixel(body.pixel_id);
    const result = await pushToMeta([event], pixelId, token);
    res.json({ ok: true, pixel: pixelId, result });
  } catch (err) {
    console.error('CAPI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Бульк-ендпоінт — корисно для batched events з CRM (наприклад, після Monobank
// webhook одразу пушимо InitiateCheckout + Purchase у двох подіях).
app.post('/v1/track-batch', async (req, res) => {
  try {
    const fromServer = req.headers['x-events-secret'];
    if (!fromServer || fromServer !== EVENTS_SECRET) {
      return res.status(401).json({ error: 'server-to-server only' });
    }
    const events = (req.body?.events || []).map((b) => ({
      event_name: b.event_name,
      event_time: b.event_time || Math.floor(Date.now() / 1000),
      event_id: b.event_id,
      event_source_url: b.event_source_url,
      action_source: b.action_source || 'system_generated',
      user_data: buildUserData(req, b),
      custom_data: b.custom_data || {},
    }));
    const { pixelId, token } = resolvePixel(req.body?.pixel_id);
    const result = await pushToMeta(events, pixelId, token);
    res.json({ ok: true, count: events.length, pixel: pixelId, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CAPI proxy listening on :${PORT}, pixel ${PIXEL_ID}`);
});
