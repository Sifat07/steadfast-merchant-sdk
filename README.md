# Steadfast Merchant SDK

An **unofficial**, zero-dependency TypeScript SDK for the [Steadfast Courier](https://steadfast.com.bd) (Packzy) merchant API: booking, status, returns, pickups, payouts, fraud check and signed webhooks.

> Community-maintained. Not affiliated with or endorsed by Steadfast Courier Ltd.

- Node.js ≥ 18 (uses built-in `fetch`), ESM and CommonJS
- Covers all 18 endpoints in Steadfast's 2026 API guide
- Validates input before sending, because Steadfast **truncates** over-long values instead of rejecting them
- Typed errors with a `kind` you can branch on, including `duplicate` for safe retries

## Install

```bash
pnpm add steadfast-merchant-sdk
```

## Quick start

```ts
import { SteadfastClient, isApprovalPending } from 'steadfast-merchant-sdk';

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY!,
  secretKey: process.env.STEADFAST_SECRET_KEY!,
});

const parcel = await steadfast.createOrder({
  invoice: 'ORD-10231',                 // letters, digits, - and _ only
  recipient_name: 'Jahid Hasan',
  recipient_phone: '+880 1712-345678',  // normalised to 01712345678
  recipient_address: 'House 17/1, Road 3/A, Dhanmondi, Dhaka-1209',
  cod_amount: 1060,
});

const status = await steadfast.getStatusByConsignmentId(parcel.consignment_id);
if (isApprovalPending(status)) {
  // rider's word only — don't settle stock or refunds yet
}
```

## API

| Method | Endpoint |
| --- | --- |
| `ping()` | `GET /ping` (no keys) |
| `createOrder(order)` | `POST /create_order` |
| `createBulkOrders(orders)` | `POST /create_order/bulk-order/extended` (≤ 500, per-row results) |
| `getStatusByConsignmentId(id)` / `ByInvoice` / `ByTrackingCode` | `GET /status_by_*` |
| `getStatusWithReturnByConsignmentId(id)` | `GET /status_with_return_status_by_cid/{id}` |
| `getTrackingByInvoice(invoice)` | `GET /trackings_by_invoice/{invoice}` |
| `createPickupRequest(req)` | `POST /create_pickup_request` |
| `createReturnRequest(target, reason?)` | `POST /create_return_request` |
| `getReturnRequest(id)` / `getReturnRequests(page?)` | `GET /get_return_request(s)` |
| `getBalance()` | `GET /get_balance` |
| `getPayments(page?)` / `getPayment(id)` | `GET /payments`, `GET /payments/{id}` |
| `getPoliceStations()` | `GET /police_stations` |
| `getFraudScore(phone)` | `GET /fraud_check/score/{phone}` |

### Statuses

- `isApprovalPending(s)`: `*_approval_pending` is the rider's report, not yet confirmed by Steadfast.
- `isFinalStatus(s)`: `delivered`, `partial_delivered` or `cancelled`, confirmed.
- `isReturnReceived(s)`: from `getStatusWithReturnByConsignmentId` only. The goods are physically back with you. Use this, not `cancelled`, to restock.

Steadfast caches status answers for 60 seconds. Use webhooks rather than polling.

## Errors

Every failure is a `SteadfastError` with a `kind`:

| kind | Meaning | Retry? |
| --- | --- | --- |
| `validation` | Rejected input (by the SDK or HTTP 400/422) | No, fix the input |
| `duplicate` | Invoice, pickup or return request already exists | No. It already happened, so look it up |
| `auth` | Bad or revoked keys (401) | **No.** 10 failures in 5 minutes locks you out for an hour |
| `forbidden` | Inactive account or KYC (403) | No |
| `not_found` | Unknown parcel or record (404) | No |
| `rate_limited` | 429 (1,000 req/min, 6,000 for booking) | Yes, after backing off |
| `unavailable` | 5xx, timeout or network | Yes, **with the same invoice** |
| `unexpected` | A response the SDK doesn't recognise. See `error.body` | — |

There are no automatic retries. Retrying a create with the **same invoice** is safe: Steadfast refuses the duplicate (`duplicate`), so a parcel can't be booked twice.

## Webhooks

Set a callback URL and an **auth token** in the merchant panel (Webhook page). Steadfast signs every request with `X-Signature` (an HMAC-SHA256 of the raw body, keyed with your token) and also sends `Authorization: Bearer <token>`.

```ts
import { handleSteadfastWebhook, isDeliveryStatusEvent } from 'steadfast-merchant-sdk/webhooks';

// Needs the RAW body. Re-serialised JSON won't match the signature.
const result = handleSteadfastWebhook({ rawBody, headers, token: process.env.STEADFAST_WEBHOOK_TOKEN! });

if (result.ok) {
  // Dedupe on result.idempotencyKey: retries repeat it.
  if (isDeliveryStatusEvent(result.event)) { /* result.event.status, .consignment_id, … */ }
}
reply.status(result.httpStatus).send(result.response);
```

Answer within 5 seconds. Steadfast retries a 5xx or a timeout after 30 seconds and again after 2 minutes, and never retries a 4xx. `delivery_status` and `tracking_update` are typed. The other events (`consignment_update`, `return_list_accepted`, `payment_request`, `cancel_request`, `return_request`, `pickup_request`, `user_update`) arrive as `{ notification_type, raw }` until Steadfast documents their payloads.

## Development

```bash
pnpm install
pnpm test          # vitest, no network
pnpm type-check
pnpm build
cp .env.example .env && pnpm build && pnpm smoke   # read-only calls against your live account
```

`pnpm smoke` never books parcels or creates requests. It prints raw responses so the types can be checked against what Steadfast actually sends.

## License

MIT
