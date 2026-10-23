import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPayments, DurableStore, signedHeaders, ShopifyClient, paymentsFromEnv, config } from '../server/shopify-payments.js';

const shop = 'pi8nda-sp.myshopify.com';
const cfg = { ...config({}), enabled: true, clientId: 'fixture-id', clientSecret: 'fixture-secret',
  outId: 'out-fixture', outSecret: 'o'.repeat(64), inId: 'in-fixture', inSecret: 'i'.repeat(64) };
const intent = (more = {}) => ({ version:3, shop_domain:shop, attempt_code:'a'.repeat(32), payment_type:'request', project_reference:'RT-0009',
  request_reference:'PR-0001', amount:'250.00', currency:'USD', description:'Payment towards your piece', test:false, ...more });
const draft = p => ({ id:'gid://shopify/DraftOrder/123', invoiceUrl:`https://${shop}/123/invoices/abc123`, status:'OPEN',
  subtotalPriceSet:{presentmentMoney:{amount:p.amount,currencyCode:'USD'}}, customAttributes:[{key:'rt_attempt_code',value:p.attempt_code}] });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-payments-')); t.after(() => rm(dir, {recursive:true,force:true}));
  const store = new DurableStore(join(dir,'state.json')); await store.load();
  const state = { creates:0, removes:0, draft:null, callbacks:[], failCallback:false };
  const api = {
    ensureWebhooks:async()=>{},
    create:async p => { state.creates++; state.draft = draft(p); return state.draft; },
    read:async()=>state.draft, find:async()=>state.draft?[state.draft]:[],
    remove:async()=>{state.removes++;state.draft=null;}, ...options.api,
  };
  const fetcher = async (url,opts) => { state.callbacks.push({url,...opts}); if(state.failCallback) throw Error('network'); return Response.json({ok:true,status:'applied'}); };
  const service = await createPayments({cfg,store,shopify:api,fetcher});
  const request = (p=intent(), path='/v1/intents', changes={}) => {
    const body=JSON.stringify(p);return new Request('https://backend.test'+path,{method:'POST',body,
      headers:{...signedHeaders(body,path,cfg.outId,cfg.outSecret),Origin:cfg.origins[0],...changes}});
  };
  return {service,store,state,api,request};
}
test('signed request creates one checkout; repeat and concurrent retry reuse it', async t => {
  const f=await fixture(t); const results=await Promise.all([f.service.handle(f.request()),f.service.handle(f.request())]);
  assert.deepEqual(results.map(r=>r.status),[200,200]); assert.equal(f.state.creates,1);
  assert.equal((await results[0].json()).draft_order_id,'gid://shopify/DraftOrder/123');
});
test('custom amounts use the same authenticated checkout flow',async t=>{
  const f=await fixture(t); const p=intent({payment_type:'custom',request_reference:'',amount:'183.27'});
  assert.equal((await f.service.handle(f.request(p))).status,200); assert.equal(f.state.draft.subtotalPriceSet.presentmentMoney.amount,'183.27');
});
test('body tampering and stale timestamps are rejected before Shopify',async t=>{
  const f=await fixture(t); const body=JSON.stringify(intent()); const h=signedHeaders(body,'/v1/intents',cfg.outId,cfg.outSecret);
  let r=await f.service.handle(new Request('https://backend.test/v1/intents',{method:'POST',body:JSON.stringify(intent({amount:'1.00'})),headers:h}));
  assert.equal(r.status,401);
  r=await f.service.handle(f.request(intent(),'/v1/intents',signedHeaders(body,'/v1/intents',cfg.outId,cfg.outSecret,'2020-01-01T00:00:00.000Z')));
  assert.equal(r.status,401);assert.equal(f.state.creates,0);
});
test('nonce cannot be replayed even after service restart',async t=>{
  const f=await fixture(t);const req=f.request(); const cloned=req.clone();assert.equal((await f.service.handle(req)).status,200);
  const reloaded=new DurableStore(f.store.path);await reloaded.load();
  const second=await createPayments({cfg,store:reloaded,shopify:f.api,fetcher:async()=>Response.json({ok:true,status:'applied'})});
  assert.equal((await second.handle(cloned)).status,409);assert.equal(f.state.creates,1);
});
test('same attempt cannot change amount; different attempt cannot overlap project',async t=>{
  const f=await fixture(t);await f.service.handle(f.request());
  assert.equal((await f.service.handle(f.request(intent({amount:'251.00'})))).status,409);
  assert.equal((await f.service.handle(f.request(intent({attempt_code:'b'.repeat(32)})))).status,409);assert.equal(f.state.creates,1);
});
test('uncertain Shopify write is not repeated after timeout',async t=>{
  let calls=0;const f=await fixture(t,{api:{create:async()=>{calls++;throw Error('timeout');}}});
  assert.equal((await f.service.handle(f.request())).status,503);assert.equal((await f.service.handle(f.request())).status,409);assert.equal(calls,1);
});
test('uncertain write can recover its exact tagged draft',async t=>{
  const f=await fixture(t);f.api.create=async p=>{f.state.creates++;f.state.draft=draft(p);throw Error('lost response');};
  assert.equal((await f.service.handle(f.request())).status,503);assert.equal((await f.service.handle(f.request())).status,200);assert.equal(f.state.creates,1);
});
test('cancel deletes draft, notifies portal, and cannot reopen',async t=>{
  const f=await fixture(t);await f.service.handle(f.request());
  const r=await f.service.handle(f.request({version:3,shop_domain:shop,attempt_code:intent().attempt_code},'/v1/intents/cancel'));
  assert.equal(r.status,200);assert.equal(f.state.removes,1);await f.service.flush();
  assert.ok(f.state.callbacks.some(c=>JSON.parse(c.body).type==='checkout.closed'));
  assert.equal((await f.service.handle(f.request())).status,409);
});
test('cancel of unknown attempt prevents late checkout creation',async t=>{
  const f=await fixture(t);await f.service.handle(f.request({version:3,shop_domain:shop,attempt_code:intent().attempt_code},'/v1/intents/cancel'));
  assert.equal((await f.service.handle(f.request())).status,409);assert.equal(f.state.creates,0);
});
test('completed draft is never deleted or announced cancelled',async t=>{
  const f=await fixture(t);await f.service.handle(f.request());f.state.draft.status='COMPLETED';
  const r=await f.service.handle(f.request({version:3,shop_domain:shop,attempt_code:intent().attempt_code},'/v1/intents/cancel'));
  assert.equal((await r.json()).state,'completed');assert.equal(f.state.removes,0);
  assert.ok(!Object.values(f.store.data.events).some(e=>e.body.type==='checkout.closed'));
});
test('delete failure retains lock and sends no closed event',async t=>{
  const f=await fixture(t,{api:{remove:async()=>{throw Error('failure');}}});await f.service.handle(f.request());
  assert.equal((await f.service.handle(f.request({version:3,shop_domain:shop,attempt_code:intent().attempt_code},'/v1/intents/cancel'))).status,503);
  assert.equal(f.store.data.attempts[intent().attempt_code].state,'open');
});
test('callback outage retains durable event and retry signature',async t=>{
  const f=await fixture(t);f.state.failCallback=true;await f.service.handle(f.request());await f.service.flush();
  assert.equal(Object.keys(f.store.data.events).length,1);f.state.failCallback=false;
  for(const event of Object.values(f.store.data.events))event.next=0;await f.service.flush();assert.equal(Object.keys(f.store.data.events).length,0);
  assert.equal(f.state.callbacks[0].headers['X-RT-Bridge-Version'],'3');
});
test('mismatched Shopify subtotal or checkout host is withheld',async t=>{
  for(const replacement of [{subtotalPriceSet:{presentmentMoney:{amount:'1.00',currencyCode:'USD'}}},{invoiceUrl:'https://evil.test/invoices/x'}]){
    const f=await fixture(t,{api:{create:async p=>({...draft(p),...replacement})}});assert.equal((await f.service.handle(f.request())).status,409);
  }
});
test('invalid money, legacy fee payload, wrong store and unsigned request are blocked',async t=>{
  const f=await fixture(t);
  for(const changes of [{amount:'1e3'},{amount:'-1.00'},{amount:'0.00'},{amount:'1.001'},{currency:'EUR'},{lines:[]},{shop_domain:'other.myshopify.com'}])
    assert.equal((await f.service.handle(f.request(intent(changes)))).status,400);
  assert.equal((await f.service.handle(new Request('https://backend.test/v1/intents',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}))).status,401);
  assert.equal(f.state.creates,0);
});
test('CORS only allows configured portal origins; normal Royal routes remain untouched',async t=>{
  const f=await fixture(t);assert.equal((await f.service.handle(f.request(intent(),'/v1/intents',{Origin:'https://evil.test'}))).status,403);
  const r=await f.service.handle(new Request('https://backend.test/v1/intents',{method:'OPTIONS',headers:{Origin:cfg.origins[0]}}));
  assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),cfg.origins[0]);
  assert.equal(await f.service.handle(new Request('https://backend.test/v1/chat')),null);
});
test('unconfigured production service fails closed without touching disk',async()=>{
  const p=await paymentsFromEnv({});assert.equal((await p.handle(new Request('https://x/v1/intents',{method:'POST'}))).status,503);
  assert.equal(await p.handle(new Request('https://x/')),null);
});
test('client credentials are cached, refreshed before expiry and never sent to other host',async()=>{
  let now=0,calls=0;const client=new ShopifyClient(cfg,async(url,opts)=>{
    assert.equal(url,`https://${shop}/admin/oauth/access_token`);assert.equal(opts.redirect,'error');calls++;
    return Response.json({access_token:'fixture-access',expires_in:86399,scope:'write_draft_orders,read_orders'});
  },()=>now);
  await Promise.all([client.accessToken(),client.accessToken()]);assert.equal(calls,1);
  now=86400000;await client.accessToken();assert.equal(calls,2);
});
test('Shopify draft preserves native tax, suppresses shipping and discounts, adds no fee',async()=>{
  const client=new ShopifyClient(cfg);let input;client.graphql=async(q,v)=>{input=v.input;return {draftOrderCreate:{draftOrder:draft(intent()),userErrors:[]}};};
  await client.create(intent());assert.equal(input.lineItems.length,1);assert.equal(input.lineItems[0].taxable,true);
  assert.equal(input.taxExempt,undefined);assert.equal(input.lineItems[0].requiresShipping,false);
  assert.equal(input.allowDiscountCodesInCheckout,false);assert.equal(input.acceptAutomaticDiscounts,false);
});
