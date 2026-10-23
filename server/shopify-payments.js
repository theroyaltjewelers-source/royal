import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const FIELDS = 'id invoiceUrl status subtotalPriceSet { presentmentMoney { amount currencyCode } } customAttributes { key value }';
export const QUERIES = {
  create: `mutation CreatePortalDraft($input: DraftOrderInput!) { draftOrderCreate(input:$input) { draftOrder { ${FIELDS} } userErrors { field message } } }`,
  read: `query ReadPortalDraft($id:ID!) { draftOrder(id:$id) { ${FIELDS} } }`,
  find: `query FindPortalDraft($query:String!) { draftOrders(first:2,query:$query) { nodes { ${FIELDS} } } }`,
  remove: 'mutation DeletePortalDraft($input:DraftOrderDeleteInput!) { draftOrderDelete(input:$input) { deletedId userErrors { field message } } }',
  hooks: 'query PortalWebhooks { webhookSubscriptions(first:100) { nodes { id uri topic } } }',
  hook: 'mutation CreatePortalWebhook($topic:WebhookSubscriptionTopic!,$webhookSubscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$webhookSubscription) { webhookSubscription { id uri } userErrors { field message } } }',
};
const fault = (status, code) => Object.assign(new Error(code), { status, code });
const sha = body => createHash('sha256').update(body).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function cents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(value)) throw fault(400, 'INVALID_AMOUNT');
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}
export function signedHeaders(body, path, keyId, secret, timestamp = new Date().toISOString(), nonce = randomUUID()) {
  const hash = sha(body);
  const message = ['RT-SHOPIFY-BRIDGE/1', 'POST', path, timestamp, nonce, hash].join('\n');
  return { 'Content-Type': 'application/json', 'X-RT-Bridge-Version': '3', 'X-RT-Key-Id': keyId,
    'X-RT-Timestamp': timestamp, 'X-RT-Nonce': nonce, 'X-RT-Content-SHA256': hash,
    'X-RT-Signature': createHmac('sha256', secret).update(message).digest('hex') };
}
export function verify(body, path, headers, cfg, now) {
  const timestamp = headers.get('x-rt-timestamp') || '';
  const nonce = headers.get('x-rt-nonce') || '';
  if (headers.get('x-rt-bridge-version') !== '3' || headers.get('x-rt-key-id') !== cfg.outId ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp)) || Math.abs(now - Date.parse(timestamp)) > 300000) throw fault(401, 'INVALID_SIGNATURE');
  const expected = signedHeaders(body, path, cfg.outId, cfg.outSecret, timestamp, nonce);
  if (!equal(headers.get('x-rt-content-sha256'), expected['X-RT-Content-SHA256']) ||
      !equal(headers.get('x-rt-signature'), expected['X-RT-Signature'])) throw fault(401, 'INVALID_SIGNATURE');
  return nonce;
}
export class DurableStore {
  constructor(path) { this.path = path; this.data = { attempts: {}, nonces: {}, events: {} }; this.tail = Promise.resolve(); }
  async load() { try { this.data = JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = this.path + '.tmp'; const file = await open(tmp, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(this.data)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, this.path);
    const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  run(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
}
export class ShopifyClient {
  constructor(cfg, fetcher = fetch, clock = Date.now) { this.cfg = cfg; this.fetcher = fetcher; this.clock = clock; this.token = null; this.refresh = null; }
  async accessToken() {
    if (this.token && this.token.expires > this.clock() + 300000) return this.token.value;
    if (!this.refresh) this.refresh = (async () => {
      const r = await this.fetcher(`https://${this.cfg.shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }) });
      if (!r.ok) throw fault(503, 'SHOPIFY_AUTHENTICATION_FAILED');
      const j = await r.json();
      if (!j.access_token || !(j.expires_in > 0)) throw fault(503, 'SHOPIFY_AUTHENTICATION_FAILED');
      const scopes = new Set(String(j.scope || '').split(','));
      if (!scopes.has('write_draft_orders') || !scopes.has('read_orders')) throw fault(503, 'SHOPIFY_SCOPES_MISSING');
      this.token = { value: j.access_token, expires: this.clock() + j.expires_in * 1000 }; return j.access_token;
    })().finally(() => { this.refresh = null; });
    return this.refresh;
  }
  async graphql(query, variables = {}) {
    const token = await this.accessToken();
    const r = await this.fetcher(`https://${this.cfg.shop}/admin/api/2026-10/graphql.json`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
    if (r.status === 401) this.token = null;
    if (!r.ok) throw fault(503, 'SHOPIFY_UNAVAILABLE');
    const j = await r.json(); if (j.errors?.length || !j.data) throw fault(503, 'SHOPIFY_API_ERROR'); return j.data;
  }
  async create(p) {
    const attributes = { rt_attempt_code: p.attempt_code, rt_project_reference: p.project_reference,
      rt_request_reference: p.request_reference, rt_payment_type: p.payment_type, rt_principal_amount: p.amount };
    const input = { presentmentCurrencyCode: 'USD', acceptAutomaticDiscounts: false, allowDiscountCodesInCheckout: false,
      tags: ['royal-t-portal', `rt_${p.attempt_code}`], customAttributes: Object.entries(attributes).map(([key, value]) => ({ key, value })),
      lineItems: [{ title: p.description || `Payment towards ${p.project_reference}`, quantity: 1, requiresShipping: false, taxable: true,
        originalUnitPriceWithCurrency: { amount: p.amount, currencyCode: 'USD' } }] };
    const data = (await this.graphql(QUERIES.create, { input })).draftOrderCreate;
    if (data.userErrors?.length || !data.draftOrder) throw fault(422, 'SHOPIFY_DRAFT_REJECTED'); return data.draftOrder;
  }
  async read(id) { return (await this.graphql(QUERIES.read, { id })).draftOrder; }
  async find(code) { return (await this.graphql(QUERIES.find, { query: `tag:rt_${code}` })).draftOrders.nodes; }
  async remove(id) {
    const data = (await this.graphql(QUERIES.remove, { input: { id } })).draftOrderDelete;
    if (data.userErrors?.length || data.deletedId !== id) throw fault(409, 'DRAFT_NOT_CANCELLED');
  }
  async ensureWebhooks() {
    const uri = 'https://royaltjewelers.repaint.site/api/shopify/webhooks';
    const current = (await this.graphql(QUERIES.hooks)).webhookSubscriptions.nodes;
    if (current.length >= 100) throw fault(503, 'WEBHOOK_SETUP_REQUIRES_REVIEW');
    for (const topic of ['ORDERS_PAID', 'ORDERS_UPDATED', 'REFUNDS_CREATE', 'DRAFT_ORDERS_CREATE', 'DRAFT_ORDERS_UPDATE', 'DRAFT_ORDERS_DELETE']) {
      if (current.some(h => h.topic === topic && h.uri === uri)) continue;
      const result = (await this.graphql(QUERIES.hook, { topic, webhookSubscription: { uri, format: 'JSON' } })).webhookSubscriptionCreate;
      if (result.userErrors?.length || !result.webhookSubscription) throw fault(503, 'WEBHOOK_SETUP_FAILED');
    }
  }
}

export function config(env) {
  return { shop: env.RT_SHOPIFY_SHOP || 'pi8nda-sp.myshopify.com', clientId: env.RT_SHOPIFY_CLIENT_ID,
    clientSecret: env.RT_SHOPIFY_CLIENT_SECRET, outId: env.RT_BRIDGE_OUT_KEY_ID, outSecret: env.RT_BRIDGE_OUT_SECRET,
    inId: env.RT_BRIDGE_IN_KEY_ID, inSecret: env.RT_BRIDGE_IN_SECRET, enabled: env.RT_PAYMENTS_ENABLED === 'true',
    path: env.RT_PAYMENTS_STORE_PATH || '/data/shopify-payments.json',
    origins: ['https://thehouseofroyaltdesign.com', 'https://design.thehouseofroyaltdesign.com', 'https://web-7zw8svdhv3082j5d2qfrddsbnw.view.repaint.com'],
    checkoutHosts: ['pi8nda-sp.myshopify.com', 'shop.thehouseofroyaltdesign.com'] };
}
function validConfig(cfg) {
  return cfg.shop === 'pi8nda-sp.myshopify.com' && cfg.clientId && cfg.clientSecret && cfg.outId && cfg.inId &&
    cfg.outSecret?.length >= 32 && cfg.inSecret?.length >= 32 && cfg.outSecret !== cfg.inSecret;
}
export function validateIntent(p, shop) {
  if (!p || p.version !== 3 || p.shop_domain !== shop || p.currency !== 'USD' || p.test !== false ||
      !/^[A-Za-z0-9_-]{32,100}$/.test(p.attempt_code || '') || !['request', 'custom'].includes(p.payment_type) ||
      typeof p.project_reference !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.project_reference) ||
      typeof p.request_reference !== 'string' || !/^[A-Za-z0-9_-]{0,100}$/.test(p.request_reference) ||
      (p.payment_type === 'request' && !p.request_reference) || typeof p.description !== 'string' || p.description.length > 250 ||
      (p.payment_type === 'custom' && !p.description.trim()) || cents(p.amount) < 100n) throw fault(400, 'INVALID_INTENT');
  if ('lines' in p || 'breakdown' in p) throw fault(400, 'OBSOLETE_FEE_OR_TAX_PAYLOAD');
  return Object.fromEntries(['version','shop_domain','attempt_code','payment_type','project_reference','request_reference','amount','currency','description','test'].map(k => [k, p[k]]));
}
function checkedDraft(draft, p, cfg) {
  if (!draft || !/^gid:\/\/shopify\/DraftOrder\/\d+$/.test(draft.id)) throw fault(409, 'DRAFT_REQUIRES_REVIEW');
  if (draft.status === 'COMPLETED') throw fault(409, 'CHECKOUT_COMPLETED');
  const m = draft.subtotalPriceSet?.presentmentMoney;
  const shopAmount = typeof m?.amount === 'string' && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(m.amount)
    ? `${m.amount.split('.')[0]}.${(m.amount.split('.')[1] || '').padEnd(2, '0')}` : null;
  if (!m || m.currencyCode !== 'USD' || !shopAmount || cents(shopAmount) !== cents(p.amount) ||
      !draft.customAttributes?.some(a => a.key === 'rt_attempt_code' && a.value === p.attempt_code)) throw fault(409, 'DRAFT_REQUIRES_REVIEW');
  let u; try { u = new URL(draft.invoiceUrl); } catch { throw fault(409, 'CHECKOUT_NOT_READY'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !cfg.checkoutHosts.includes(u.hostname) || !u.pathname.includes('/invoices/')) throw fault(409, 'CHECKOUT_URL_INVALID');
  return { checkout_url: u.href, draft_order_id: draft.id, attempt_code: p.attempt_code };
}

export async function createPayments({ cfg, store, shopify, fetcher = fetch, clock = Date.now }) {
  let webhookReady = false;
  let settingUp;
  const callbackURL = 'https://thehouseofroyaltdesign.com/api/shopify-bridge/v1/events';
  const callbackPath = '/api/shopify-bridge/v1/events';
  const ready = () => Boolean(cfg.enabled && validConfig(cfg));
  async function setup() {
    if (!ready() || webhookReady) return;
    if (!settingUp) settingUp = shopify.ensureWebhooks().then(() => { webhookReady = true; }).finally(() => { settingUp = null; });
    await settingUp;
  }
  function queue(type, p, fields) {
    const id = `${type}:${p.attempt_code}`;
    if (!store.data.events[id]) store.data.events[id] = { body: { event_id: id, type, shop_domain: cfg.shop, attempt_code: p.attempt_code, ...fields }, tries: 0, next: 0 };
  }
  async function flush() {
    if (!ready()) return;
    await store.run(async () => {
      for (const [id, item] of Object.entries(store.data.events)) {
        if (item.next > clock()) continue;
        const body = JSON.stringify(item.body); let applied = false;
        try {
          const r = await fetcher(callbackURL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
            headers: signedHeaders(body, callbackPath, cfg.inId, cfg.inSecret, new Date(clock()).toISOString()), body });
          const j = r.ok ? await r.json() : {};
          applied = r.ok && j.ok === true && (j.duplicate === true || j.status === 'applied' || j.status === 'ignored');
          if (j.status === 'review') item.review = true;
        } catch { /* Leave a durable event for the next retry. */ }
        if (applied) delete store.data.events[id];
        else { item.tries++; item.next = clock() + Math.min(300000, 1000 * 2 ** Math.min(item.tries, 8)); }
        await store.save();
      }
    });
  }
  async function create(p) {
    const fingerprint = sha(JSON.stringify(p)); let entry = store.data.attempts[p.attempt_code];
    if (entry && entry.fingerprint !== fingerprint) throw fault(409, 'ATTEMPT_AMOUNT_CHANGED');
    if (entry?.state === 'cancelled') throw fault(409, 'CHECKOUT_CANCELLED');
    if (entry?.state === 'completed') throw fault(409, 'CHECKOUT_COMPLETED');
    if (entry?.state === 'rejected') throw fault(409, 'CHECKOUT_REJECTED');
    let draft;
    if (entry?.draftId) draft = await shopify.read(entry.draftId);
    else if (entry) {
      // A crash or timeout after sending draftOrderCreate must NEVER blindly create another draft.
      const found = await shopify.find(p.attempt_code);
      if (found.length !== 1) throw fault(409, 'CHECKOUT_CREATION_UNCERTAIN');
      draft = found[0];
    } else {
      for (const old of Object.values(store.data.attempts)) {
        if (old.p.project_reference !== p.project_reference || ['cancelled','completed','rejected'].includes(old.state)) continue;
        if (!old.draftId) throw fault(409, 'PROJECT_HAS_PENDING_CHECKOUT');
        const existing = await shopify.read(old.draftId);
        if (existing?.status === 'COMPLETED') old.state = 'completed';
        else if (!existing) old.state = 'cancelled';
        else throw fault(409, 'PROJECT_HAS_PENDING_CHECKOUT');
      }
      entry = store.data.attempts[p.attempt_code] = { p, fingerprint, state: 'creating', created: clock() };
      await store.save();
      try { draft = await shopify.create(p); }
      catch (e) { if (e.code === 'SHOPIFY_DRAFT_REJECTED') { entry.state = 'rejected'; await store.save(); } throw e; }
    }
    if (draft?.id) { entry.draftId = draft.id; await store.save(); }
    const result = checkedDraft(draft, p, cfg);
    entry.state = 'open';
    queue('checkout.opened', p, { ...result, amount: p.amount, currency: p.currency });
    await store.save(); return result;
  }
  async function cancel(p) {
    if (p.version !== 3 || p.shop_domain !== cfg.shop || !/^[A-Za-z0-9_-]{32,100}$/.test(p.attempt_code || '')) throw fault(400, 'INVALID_CANCEL');
    let entry = store.data.attempts[p.attempt_code];
    // An unknown cancel still gets a durable tombstone, preventing a delayed create from opening it.
    if (!entry) {
      entry = store.data.attempts[p.attempt_code] = { p, state: 'cancelled', created: clock() };
      queue('checkout.closed', p, { draft_order_id: null, payable: false, state: 'cancelled' }); await store.save(); return { ok: true, state: 'cancelled' };
    }
    if (entry.state === 'cancelled') return { ok: true, state: 'cancelled' };
    let draft = entry.draftId ? await shopify.read(entry.draftId) : null;
    if (!entry.draftId && entry.state === 'creating') {
      const found = await shopify.find(p.attempt_code); if (found.length !== 1) throw fault(409, 'CHECKOUT_CREATION_UNCERTAIN'); draft = found[0]; entry.draftId = draft.id;
    }
    if (draft?.status === 'COMPLETED' || entry.state === 'completed') { entry.state = 'completed'; await store.save(); return { ok: true, state: 'completed' }; }
    if (draft) {
      // Shopify is the authority on whether a draft can be deleted; never announce cancellation after failure.
      await shopify.remove(draft.id);
    }
    entry.state = 'cancelled'; queue('checkout.closed', entry.p, { draft_order_id: entry.draftId || null, payable: false, state: 'cancelled' });
    await store.save(); return { ok: true, state: 'cancelled' };
  }
  async function handle(request) {
    const u = new URL(request.url);
    if (!['/v1/intents','/v1/intents/cancel','/v1/payments/health'].includes(u.pathname)) return null;
    const origin = request.headers.get('origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers });
    if (origin && !cfg.origins.includes(origin)) return reply(403, { error: 'ORIGIN_NOT_ALLOWED' });
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (u.pathname === '/v1/payments/health' && request.method === 'GET') return reply(ready() && webhookReady ? 200 : 503, { configured: Boolean(validConfig(cfg)), enabled: cfg.enabled, webhooks_ready: webhookReady, version: 3 });
    if (request.method === 'OPTIONS') {
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-RT-Bridge-Version, X-RT-Key-Id, X-RT-Timestamp, X-RT-Nonce, X-RT-Content-SHA256, X-RT-Signature';
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST' || u.search) return reply(405, { error: 'METHOD_NOT_ALLOWED' });
    if (!ready()) return reply(503, { error: 'PAYMENTS_NOT_CONFIGURED' });
    try {
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw fault(415, 'JSON_REQUIRED');
      const raw = Buffer.from(await request.arrayBuffer()); if (raw.length > 20000) throw fault(413, 'BODY_TOO_LARGE');
      const nonce = verify(raw, u.pathname, request.headers, cfg, clock());
      let p; try { p = JSON.parse(raw.toString('utf8')); } catch { throw fault(400, 'INVALID_JSON'); }
      if (u.pathname === '/v1/intents') p = validateIntent(p, cfg.shop);
      await setup();
      const result = await store.run(async () => {
        for (const [key, expiry] of Object.entries(store.data.nonces)) if (expiry < clock()) delete store.data.nonces[key];
        if (store.data.nonces[nonce]) throw fault(409, 'NONCE_REUSED');
        store.data.nonces[nonce] = clock() + 600000; await store.save();
        return u.pathname === '/v1/intents' ? create(p) : cancel(p);
      });
      void flush().catch(() => {}); return reply(200, result);
    } catch (e) { return reply(e.status || 503, { error: e.code || 'PAYMENT_SERVICE_UNAVAILABLE' }); }
  }
  return { handle, setup, flush };
}
export async function paymentsFromEnv(env) {
  const cfg = config(env);
  // No persistence or networking is touched until explicitly configured.
  if (!cfg.enabled || !validConfig(cfg)) return { handle: async req => {
    if (!['/v1/intents','/v1/intents/cancel','/v1/payments/health'].includes(new URL(req.url).pathname)) return null;
    return Response.json({ error: 'PAYMENTS_NOT_CONFIGURED', configured: false, version: 3 }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } };
  const store = new DurableStore(cfg.path); await store.load();
  const service = await createPayments({ cfg, store, shopify: new ShopifyClient(cfg) });
  const tick = () => service.setup().then(() => service.flush()).catch(e => console.error('PORTAL_PAYMENTS', e.code || 'UNAVAILABLE'));
  void tick(); const timer = setInterval(tick, 30000); timer.unref(); return service;
}
