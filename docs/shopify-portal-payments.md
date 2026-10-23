# Royal T portal checkout backend

The existing Royal Render service hosts three isolated routes:

- `POST /v1/intents` creates or resumes a Shopify draft checkout.
- `POST /v1/intents/cancel` deletes an unpaid draft before releasing its portal attempt.
- `GET /v1/payments/health` reports configuration and webhook setup readiness, never secrets.

Repaint authenticates clients and checks ownership, request amount and remaining project balance before signing each handoff. Both request payments and custom payments use protocol version 3. Amounts are USD decimal strings, $1–$1,000,000. Native Shopify tax applies; there are no service fee or synthetic tax lines. The original request amount is the principal, excluding tax added by Shopify.

## Render environment

Set these only in Render's environment settings, never in source control:

| Name | Value |
| --- | --- |
| `RT_PAYMENTS_ENABLED` | `true` when configuring the connection |
| `RT_SHOPIFY_SHOP` | `pi8nda-sp.myshopify.com` |
| `RT_SHOPIFY_CLIENT_ID` | Client ID of Royal t portal payments |
| `RT_SHOPIFY_CLIENT_SECRET` | Secret from that installed Shopify app |
| `RT_BRIDGE_OUT_KEY_ID` | Outgoing key ID generated in Repaint |
| `RT_BRIDGE_OUT_SECRET` | Outgoing secret generated in Repaint (minimum 32 characters) |
| `RT_BRIDGE_IN_KEY_ID` | Incoming key ID generated in Repaint |
| `RT_BRIDGE_IN_SECRET` | Incoming secret generated in Repaint, distinct from outgoing secret |
| `RT_PAYMENTS_STORE_PATH` | `/data/shopify-payments.json` |

Use one process/instance with the existing persistent disk. This implementation serializes checkout operations and flushes state before Shopify mutations. Do not scale to multiple writers without replacing the file store with transactional database locks.

Repaint's webhook secret must be the same app Client secret. Backend startup registers app-owned `ORDERS_PAID`, `ORDERS_UPDATED`, `REFUNDS_CREATE`, `DRAFT_ORDERS_CREATE`, `DRAFT_ORDERS_UPDATE`, and `DRAFT_ORDERS_DELETE` subscriptions at `https://royaltjewelers.repaint.site/api/shopify/webhooks`. Order updates let Repaint reconcile refunds that were pending when first created. It does not replace unrelated subscriptions. The app needs `write_draft_orders` and `read_orders`; it never issues refunds. Keep the Repaint webhook domain connected to the website.

## Protocol

Headers: `X-RT-Bridge-Version: 3`, `X-RT-Key-Id`, `X-RT-Timestamp` (ISO UTC), `X-RT-Nonce` (16–100 URL-safe characters), `X-RT-Content-SHA256` and `X-RT-Signature` (lowercase hex).

HMAC-SHA256 over these newline-separated values, without a trailing newline:

```text
RT-SHOPIFY-BRIDGE/1
POST
/v1/intents
<timestamp>
<nonce>
<SHA256 of raw body bytes>
```

The cancel route uses its own exact path in the signature. Outgoing Repaint key signs requests; incoming Repaint key signs callbacks to `/api/shopify-bridge/v1/events`. The callback origin is always `https://thehouseofroyaltdesign.com`.

Create body:

```json
{"version":3,"shop_domain":"pi8nda-sp.myshopify.com","attempt_code":"<32-100 URL-safe characters>","payment_type":"request","project_reference":"RT-0009","request_reference":"PR-0001","amount":"250.00","currency":"USD","description":"Payment towards your piece","test":false}
```

Custom payments use `payment_type: "custom"` and an empty request reference. The server returns `checkout_url`, `draft_order_id`, and `attempt_code`. The portal redirects only after validating that response.

Only Shopify's verified paid webhook credits balances. Browser returns and bridge callbacks never prove payment. Backend callbacks persist in an outbox and retry after outages, with stable event IDs and fresh signatures. Repaint must deduplicate by event ID and Shopify order ID.

## Recovery and launch checks

- An uncertain create is recovered by its exact attempt tag. If no unique draft can be found, it stays blocked for owner review; it is never blindly re-created.
- A completed draft is never deleted or reported cancelled.
- Cancellation stores a tombstone, including when it arrives before creation.
- Confirm `GET /v1/payments/health` returns 200 only after configuration and webhook registration.
- Verify a signed portal checkout, correct principal/native tax, callback matching, and paid notification before changing portal mode to Live.
- Real card submission requires the owner's action. Do not enable store-wide test mode on the production store.

Tests: `node --test tests/shopify-payments.test.js`, then `npm test`.

Official references: https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant and https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate.
