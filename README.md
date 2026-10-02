# Steadfast Merchant SDK

[![npm](https://img.shields.io/npm/v/steadfast-merchant-sdk)](https://www.npmjs.com/package/steadfast-merchant-sdk)
[![CI](https://github.com/Sifat07/steadfast-merchant-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Sifat07/steadfast-merchant-sdk/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An **unofficial**, zero-dependency TypeScript SDK for the [Steadfast Courier](https://steadfast.com.bd) (Packzy) merchant API: booking, status, returns, pickups, payouts, fraud check and signed webhooks.

> **Disclaimer:** community-maintained. Not affiliated with or endorsed by Steadfast Courier Ltd. Built from Steadfast's in-panel API and Webhook guides (2026), cross-checked against Steadfast's own [Laravel package](https://github.com/steadfast-it/SteadFast-Courier-Laravel-Package). See [What's verified](#whats-verified).

- **Complete:** all 18 endpoints in the 2026 API guide.
- **Zero runtime dependencies:** Node's built-in `fetch` and `crypto`. ESM and CommonJS, with types.
- **Fails loudly:** Steadfast *truncates* over-long values instead of rejecting them, so the SDK checks limits before sending.
- **Safe retries:** typed errors with a `kind`. `duplicate` tells you an earlier attempt already booked the parcel.
- **Signed webhooks:** Bearer token plus HMAC `X-Signature`, framework-agnostic, with retry dedupe via `Idempotency-Key`.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [The parcel lifecycle](#the-parcel-lifecycle)
- [API reference](#api-reference)
  - [Booking](#booking)
  - [Status and tracking](#status-and-tracking)
  - [Pickups](#pickups)
  - [Returns](#returns)
  - [Balance and payouts](#balance-and-payouts)
  - [Lookups](#lookups)
  - [Helpers](#helpers)
- [Errors and retries](#errors-and-retries)
- [Webhooks](#webhooks)
- [Statuses](#statuses)
- [What's verified](#whats-verified)
- [Examples](#examples)
- [Development](#development)
- [License](#license)

## Requirements

- Node.js ≥ 18 at runtime. Developing the SDK itself needs Node ≥ 22.
- A Steadfast merchant account. Keys are issued under **API → Your API keys** in the panel. A key belongs to one business profile and sees only that profile's parcels and payouts.

**Steadfast has no sandbox.** Every booking on a live key is a real parcel. Test against a fake `fetch` (see [Configuration](#configuration)).

## Install

```bash
pnpm add steadfast-merchant-sdk
# or
npm install steadfast-merchant-sdk
```

## Quick start

```ts
import { SteadfastClient } from 'steadfast-merchant-sdk';

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY!,
  secretKey: process.env.STEADFAST_SECRET_KEY!,
});

const parcel = await steadfast.createOrder({
  invoice: 'ORD-10231',                 // your order number
  recipient_name: 'Jahid Hasan',
  recipient_phone: '+880 1712-345678',  // sent as 01712345678
  recipient_address: 'House 17/1, Road 3/A, Dhanmondi, Dhaka-1209',
  cod_amount: 1060,                     // whole taka; 0 if prepaid
});

parcel.consignment_id; // 1424107 — use for API lookups
parcel.tracking_code;  // '15BAEB8A' — show to the customer
parcel.status;         // 'in_review' — every parcel starts here
```

## Configuration

```ts
new SteadfastClient({
  apiKey: string,         // required
  secretKey: string,      // required
  baseUrl?: string,       // default 'https://portal.packzy.com/api/v1'
  timeoutMs?: number,     // default 30000, per request
  fetch?: typeof fetch,   // inject for tests, proxies or logging
});
```

The SDK never reads environment variables itself: what you pass is what it uses. That matters when one app serves several merchants with their own keys.

Every method takes an optional last argument `{ signal?: AbortSignal }` to cancel the call.

The client never follows redirects. `Api-Key` and `Secret-Key` are custom headers, and `fetch` would forward them to a redirect target.

## The parcel lifecycle

The order most integrations follow. Each step links to its method below.

1. **Book** with [`createOrder`](#createorderorder) or [`createBulkOrders`](#createbulkordersorders). Store `consignment_id` and `tracking_code`. On a timeout, retry with the **same invoice**.
2. **Get a rider** with [`createPickupRequest`](#createpickuprequestreq), unless you have scheduled pickups.
3. **Follow it** with [webhooks](#webhooks). Status answers are cached for 60 s, so polling faster tells you nothing new.
4. **Act on confirmed outcomes only.** `delivered_approval_pending` is the rider's report. `delivered` is Steadfast confirming it, and the COD is now owed to you ([`isFinalStatus`](#helpers)).
5. **Returns:** `cancelled` means *coming back*, not *back*. Restock only when [`getStatusWithReturnByConsignmentId`](#getstatuswithreturnbyconsignmentidid) says `*_return_received` ([`isReturnReceived`](#helpers)).
6. **Reconcile money** with [`getBalance`](#getbalance) and [`getPayment`](#getpaymentpaymentid), which lists every parcel a payout settled.

## API reference

All methods are async and throw [`SteadfastError`](#errors-and-retries) on failure.

### Booking

#### `createOrder(order)`

`POST /create_order` — book one parcel. Returns the `Consignment`.

| Field | Type | Rules (checked before sending) |
| --- | --- | --- |
| `invoice` | string | **Required.** Letters, digits, `-`, `_`; ≤ 100. Unique per account; a repeat is refused, which is what makes retries safe. |
| `recipient_name` | string | **Required.** ≤ 100 |
| `recipient_phone` | string | **Required.** BD mobile. `+880…`, `880…`, spaces and dashes are normalised to `01XXXXXXXXX`. |
| `recipient_address` | string | **Required.** ≤ 490 |
| `cod_amount` | number | **Required.** Whole taka, 0 to 1,000,000. `0` for prepaid. |
| `alternative_phone` | string | BD mobile, normalised like `recipient_phone` |
| `recipient_email` | string | Steadfast checks the domain is deliverable |
| `note` | string | For the rider. ≤ 480 |
| `item_description` | string | ≤ 255 |
| `total_lot` | number | Item count, ≥ 1. Default 1. |
| `delivery_type` | `DeliveryType` | `HOME` (0, default) or `POINT` (1, hub pickup) |

```ts
{
  consignment_id: 1424107,
  invoice: 'ORD-10231',
  tracking_code: '15BAEB8A',
  tracking_link: 'https://steadfast.com.bd/t/a1b2c3d4',
  recipient_name: 'Jahid Hasan',
  recipient_phone: '01712345678',
  recipient_address: 'House 17/1, Road 3/A, Dhanmondi, Dhaka-1209',
  recipient_email: null, alternative_phone: null, item_description: null,
  total_lot: 1,
  cod_amount: 1060,
  status: 'in_review',
  note: null,
  created_at: '2026-09-20T07:05:31.000000Z',
  updated_at: '2026-09-20T07:05:31.000000Z',
}
```

Steadfast also replaces some characters (`<`, `>`, `;` and a few others) with spaces in names, addresses and notes. What you send isn't always exactly what comes back.

#### `createBulkOrders(orders)`

`POST /create_order/bulk-order/extended` — book up to 500 parcels in one call. Every order is validated, and invoices must be unique within the batch, before anything is sent.

The call succeeds even when some orders fail. Results come back **in the order sent**, one per order:

```ts
const results = await steadfast.createBulkOrders(orders);
// [
//   { ok: true,  invoice: 'ORD-10231', consignment_id: 1424107, tracking_code: '15BAEB8A', tracking_link: '…' },
//   { ok: false, invoice: 'ORD-10232', errors: ['The recipient phone format is invalid.'] },
// ]
const failed = results.filter((r) => !r.ok);
// Fix the failures and re-send only those, keeping their invoices.
```

The extended endpoint returns readable messages instead of codes, and honours `recipient_email`, `alternative_phone`, `item_description` and `total_lot` per order.

### Status and tracking

#### `getStatusByConsignmentId(id)` / `getStatusByInvoice(invoice)` / `getStatusByTrackingCode(code)`

`GET /status_by_cid/{id}`, `/status_by_invoice/{invoice}`, `/status_by_trackingcode/{code}` — where the parcel is now, as a [`DeliveryStatus`](#statuses). Cached by Steadfast for 60 s. If one invoice was somehow booked twice, the invoice lookup answers for the latest.

```ts
await steadfast.getStatusByConsignmentId(1424107); // 'delivered'
```

#### `getStatusWithReturnByConsignmentId(id)`

`GET /status_with_return_status_by_cid/{id}` — like the above, but for a parcel coming back it says how far back it has got: `cancelled_return_processing`, then `…_rider_assigned`, then `…_received` (and the same for `partial_delivered_*`). **This is the only signal that returned goods are physically with you.** Use it for stock.

#### `getTrackingByInvoice(invoice)`

`GET /trackings_by_invoice/{invoice}` — every step the parcel has been through. Use it for a "where is my order?" page.

```ts
[
  { consignment_id: 1424107, tracking_type: 1, text: 'Consignment created by Sender(API).', created_at: '…' },
  { consignment_id: 1424107, tracking_type: 2, text: 'Parcel received at Dhanmondi hub.', created_at: '…' },
]
```

### Pickups

#### `createPickupRequest(req)`

`POST /create_pickup_request` — ask a rider to collect from one of your saved addresses.

| Field | Type | Notes |
| --- | --- | --- |
| `address_id` | number | **Required.** From the panel's Pickup Addresses page |
| `police_station_id` | number | **Required.** The thana, from [`getPoliceStations`](#getpolicestations) |
| `address` | string | **Required.** ≤ 255 |
| `contact_number` | string | **Required.** BD mobile, normalised |
| `note` | string | ≤ 500 |
| `estim_qty` | number | Roughly how many parcels are waiting |

Asking again for the same address while one request is pending throws `kind: 'duplicate'` (HTTP 409). It's safe to retry: you won't get two riders.

### Returns

#### `createReturnRequest(target, reason?)`

`POST /create_return_request` — ask for a parcel to come back **before** it's delivered. Name the parcel by exactly one of `{ consignment_id }`, `{ invoice }` or `{ tracking_code }`. `reason` ≤ 500.

```ts
const req = await steadfast.createReturnRequest({ invoice: 'ORD-10231' }, 'Customer changed their mind');
// { id: 1, consignment_id: 1424107, status: 'pending', reason: '…', … }
```

Refused with `validation` (422) for a parcel already delivered or already coming back, and with `duplicate` while an earlier request for it is still open. Request statuses: `pending`, `approved`, `processing`, `completed`, `cancelled`.

#### `getReturnRequest(id)` / `getReturnRequests(page = 1)`

`GET /get_return_request/{id}` and `GET /get_return_requests`. The list is newest first, ten per page, returned as `{ items, page }`.

### Balance and payouts

#### `getBalance()`

`GET /get_balance` — delivered COD minus delivery charges and Steadfast's 1% collection charge, in taka. It's what you could request a payout of right now.

#### `getPayments(page = 1)`

`GET /payments` — payouts made to you, ten per page, as `{ items: Payout[], page }`.

```ts
{ payment_id: 'SFC-88213', amount: 12450, method: 'bKash', due_bills: 0, paid_bills: 3200,
  charges: 124, total: 12450, status_label: 'Paid', created_at: '…', ready_at: '…', paid_at: '…' }
```

#### `getPayment(paymentId)`

`GET /payments/{id}` — one payout with every parcel it settled, each with its `invoice`. Use it to reconcile against your orders. Accepts `'SFC-88213'` or `88213` (non-digits are dropped). Returned as an untyped object for now ([why](#whats-verified)).

### Lookups

#### `getPoliceStations()`

`GET /police_stations` — every thana Steadfast delivers to, with its district. Changes rarely, so cache it.

#### `getFraudScore(phone)`

`GET /fraud_check/score/{phone}` — a customer's delivery record across **all** merchants. It's a signal, not a verdict.

```ts
{ phone: '01712345678', delivery_ratio: 92, cancellation_ratio: 7, volume_band: 'high',
  total_reports: 0, fraud_categories: [], score: null, level: null, reasons: [],
  scoring_disabled: true, doubtful_reports: false }
```

- `delivery_ratio` and `cancellation_ratio` are whole percents of *finished* parcels. They're each rounded down, so they may add up to 99. They're **`null` when nothing has finished**. Don't show null as a clean record.
- `volume_band` (`none`, `low` 1–5, `medium` 6–20, `high` 21–200, `very_high` 200+) is how many parcels the number has received across every merchant.
- `score` and `level` are always `null` while Steadfast has scoring disabled.
- Rate-limited per merchant, against your own booking volume.

#### `ping()`

`GET /ping` — needs no keys. If it works and other calls fail, the problem is your keys or request, not the network.

### Helpers

| Export | Use |
| --- | --- |
| `isApprovalPending(status)` | `*_approval_pending`: the rider's report, not confirmed. Don't settle money or stock on it. |
| `isFinalStatus(status)` | `delivered`, `partial_delivered` or `cancelled`, confirmed by Steadfast |
| `isReturnReceived(status)` | `*_return_received`: the goods are back with you |
| `isDeliveryStatus(x)` / `isReturnStatus(x)` | Type guards for unknown strings |
| `normalizeBdPhone(input)` | `'+880 1712-345678'` → `'01712345678'`, or `null` if it isn't a BD mobile |
| `DELIVERY_STATUSES`, `RETURN_STATUSES` | Every known status, as arrays |
| `FIELD_LIMITS`, `BULK_ORDER_LIMIT` | The limits the SDK enforces |

## Errors and retries

Every failure is a `SteadfastError` with a `kind`, the `httpStatus` (if there was a response), the parsed `body`, and a `retryable` flag.

| `kind` | Meaning | Retry? |
| --- | --- | --- |
| `validation` | Rejected input, by the SDK before sending or by Steadfast (400/422). `message` names the field. | No, fix the input |
| `duplicate` | The invoice, pickup or return request already exists | No. It already happened, so look it up |
| `auth` | Missing, wrong or revoked keys (401) | **Never in a loop:** 10 failures in 5 minutes locks you out for an hour |
| `forbidden` | Inactive account or KYC needs resubmitting (403) | No |
| `not_found` | Unknown parcel or record (404) | No |
| `rate_limited` | 429. Limits: 1,000 requests a minute, 6,000 for booking | Yes, after backing off |
| `unavailable` | 5xx, timeout, network failure, or a non-JSON reply (e.g. a proxy page) | Yes, **with the same invoice** |
| `unexpected` | A response the SDK doesn't understand. Check `error.body`. | Report it |

The SDK has **no automatic retries**: whether to retry a booking is your decision. It's safe as long as you keep the invoice, because Steadfast refuses a repeat:

```ts
try {
  await steadfast.createOrder(order);
} catch (e) {
  if (e instanceof SteadfastError && e.kind === 'duplicate') {
    // an earlier attempt landed — fetch it instead
    return steadfast.getStatusByInvoice(order.invoice);
  }
  if (e instanceof SteadfastError && e.retryable) { /* back off, then retry the same order */ }
  throw e;
}
```

## Webhooks

In the merchant panel's **Webhook** page, set an https **Callback URL** and an **Auth token**. Without a token there's nothing to verify, and this SDK refuses every request.

Each request carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <your auth token>`. **Always checked.** |
| `X-Signature` | Hex HMAC-SHA256 of the **raw body**, keyed with the token. Checked whenever present. |
| `Idempotency-Key` | The same value on every retry of one event |
| `User-Agent` | `Steadfast-Webhook/1.0` |

**Delivery rules:** Steadfast waits 5 seconds for a 2xx. A 5xx or no answer is retried after 30 s and again after 2 minutes. A 4xx is **never** retried. So: verify, record the `Idempotency-Key`, answer 200, and do slow work afterwards.

### Handling a request

```ts
import { handleSteadfastWebhook, isDeliveryStatusEvent } from 'steadfast-merchant-sdk/webhooks';

const result = handleSteadfastWebhook({
  rawBody,                                   // Buffer or string — the exact bytes received
  headers,                                   // request headers, any casing
  token: process.env.STEADFAST_WEBHOOK_TOKEN!,
  // requireSignature: true,                 // see below
});

if (result.ok) {
  // dedupe on result.idempotencyKey
  if (isDeliveryStatusEvent(result.event)) {
    result.event.status;       // 'delivered', 'partial_delivered', 'cancelled', …
    result.event.cod_amount;   // for partial_delivered: what was actually collected
  }
}
reply.status(result.httpStatus).send(result.response);
```

**You need the raw body.** The signature covers the exact bytes. If a JSON parser runs first and you re-serialise its output, the signature won't match, even when the content is identical. Complete, tested setups:

- **Fastify:** a buffer content-type parser scoped to the webhook route — [`examples/webhook-fastify.ts`](examples/webhook-fastify.ts)
- **Express:** `express.raw({ type: 'application/json' })` on the route, mounted before any global `express.json()` — [`examples/webhook-express.ts`](examples/webhook-express.ts)

**`requireSignature`:** the Bearer token is always required. `X-Signature` appears in Steadfast's 2026 guide but not in their Laravel package, so by default it's verified when present and not demanded when absent. Once you've seen it on your own live events, pass `requireSignature: true`. Don't turn it on before then: Steadfast never retries a 4xx, so requiring a header that doesn't arrive would drop every event.

### Events

| `notification_type` | Typed as | When |
| --- | --- | --- |
| `delivery_status` | `DeliveryStatusEvent` | A parcel's status changed: `consignment_id`, `invoice`, `status`, `cod_amount`, `delivery_charge`, `tracking_message`, `updated_at` |
| `tracking_update` | `TrackingUpdateEvent` | A new tracking step: `consignment_id`, `invoice`, `tracking_message`, `updated_at` |
| `consignment_update`, `return_list_accepted`, `payment_request`, `cancel_request`, `return_request`, `pickup_request`, `user_update` | `UntypedEvent` (`{ notification_type, raw }`) | Listed by Steadfast, payloads not documented yet |

Statuses are passed through exactly as sent (lower-cased). Unknown ones aren't rejected or rewritten. Amounts may arrive as numbers or numeric strings; anything else answers 400.

Lower-level pieces, if you need them: `verifySteadfastWebhook(rawBody, headers, token, options)`, `parseSteadfastWebhook(body)` and `signSteadfastWebhook(rawBody, token)` (useful for tests).

## Statuses

`DeliveryStatus`, from the status lookups:

| Status | Meaning | Final? |
| --- | --- | --- |
| `in_review` | Just booked, awaiting Steadfast's approval. Every parcel starts here. | |
| `pending` | Booked, not yet attempted | |
| `hold` | Held, usually an address or payment question. Contact support. | |
| `delivered_approval_pending` | Rider marked it delivered; not confirmed yet | |
| `partial_delivered_approval_pending` | Rider marked it partially delivered; not confirmed | |
| `cancelled_approval_pending` | Rider marked it cancelled; not confirmed | |
| `unknown_approval_pending` | Awaiting confirmation; outcome is none of the above | |
| `delivered` | Delivered and confirmed. The COD is now owed to you. | ✓ |
| `partial_delivered` | Part delivered and confirmed | ✓ |
| `cancelled` | Not delivered, confirmed. **The parcel is coming back.** | ✓ |
| `exceptional` | Lost, damaged or otherwise off the normal path. Contact support. | |
| `unknown` | A state the API doesn't recognise. Treat as "ask Steadfast". | |

`ReturnStatus`, only from `getStatusWithReturnByConsignmentId`, for a parcel that didn't fully arrive: `{partial_delivered,cancelled}_return_{processing,rider_assigned,received}`.

## What's verified

Shapes come from Steadfast's 2026 in-panel guides, checked against their Laravel package and two independent integrations. Not yet confirmed against a live account:

- **The `data` encoding for bulk create.** The guide says an array; the Laravel package sends a JSON string. The SDK sends the array, and if Steadfast answers 400 (nothing booked), it retries once with the string.
- **`X-Signature` on live webhooks**, hence `requireSignature` defaulting to off.
- **Shapes the guide doesn't show:** `getPoliceStations`, `getPayment`, and the extra parcel fields in `getReturnRequest`. These are returned as received; list endpoints accept a bare array or a `data` / paginator wrapper.

`pnpm smoke` (below) prints raw responses from your account so these can be checked. Please [open an issue](https://github.com/Sifat07/steadfast-merchant-sdk/issues) with anything that doesn't match. Remove keys and customer data first.

## Examples

[`examples/`](examples/) has runnable, type-checked files:

- `book-and-track.ts`: booking with safe retries, then status and history
- `webhook-fastify.ts` and `webhook-express.ts`: complete signed-webhook endpoints
- `reconcile-returns.ts`: restocking only when a return is back

## Development

```bash
pnpm install
pnpm test          # vitest; no network
pnpm type-check    # includes tests and examples
pnpm build         # dist/: ESM, CJS and .d.ts
```

To check against your own account without booking anything:

```bash
cp .env.example .env   # add STEADFAST_API_KEY / STEADFAST_SECRET_KEY
pnpm build && pnpm smoke
```

`pnpm smoke` calls only read endpoints (ping, balance, returns, payouts, police stations, and status lookups if you set a consignment ID and invoice) and prints the raw responses. It never books parcels or creates requests.

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## License

[MIT](LICENSE) © Sifat Jasim
