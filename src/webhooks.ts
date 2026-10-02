/**
 * Steadfast webhook support — framework-agnostic.
 *
 * Each request carries:
 *   Authorization:   Bearer <your auth token>
 *   X-Signature:     hex HMAC-SHA256 of the raw body, keyed with the same token
 *   Idempotency-Key: identical across retries of one event
 *   User-Agent:      Steadfast-Webhook/1.0
 *
 * The signature is checked against the **raw** body bytes, so register a raw
 * body parser for this route — re-serialising parsed JSON changes the bytes.
 *
 * Delivery: Steadfast waits 5 s for a 2xx. A 5xx or no answer is retried after
 * 30 s and 2 min (3 attempts in all); a 4xx is never retried. So: verify,
 * record the event by Idempotency-Key, answer 200, and do slow work after.
 *
 * The auth token is optional in the merchant panel. Without one there is
 * nothing to check, and this module refuses every request — set a token.
 *
 * The Bearer token is always required. `X-Signature` is documented in the
 * 2026 panel guide but not by Steadfast's own Laravel package or any other
 * integration seen so far, so by default it is checked when present and not
 * required when absent. Pass `requireSignature: true` once you have seen it
 * on your live events: a 4xx is never retried, so requiring a header that
 * doesn't arrive would silently drop every event.
 *
 * @example Fastify
 * ```ts
 * import { handleSteadfastWebhook } from 'steadfast-merchant-sdk/webhooks';
 *
 * app.post('/webhooks/steadfast', { config: { rawBody: true } }, async (req, reply) => {
 *   const result = handleSteadfastWebhook({
 *     rawBody: req.rawBody!,                 // e.g. via fastify-raw-body
 *     headers: req.headers,
 *     token: process.env.STEADFAST_WEBHOOK_TOKEN!,
 *   });
 *   if (result.ok) await saveOnce(result.idempotencyKey, result.event);
 *   return reply.code(result.httpStatus).send(result.response);
 * });
 * ```
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeliveryStatus } from './types';

export class SteadfastWebhookError extends Error {
  constructor(
    readonly reason: 'unauthorized' | 'invalid_payload',
    message: string,
  ) {
    super(message);
    this.name = 'SteadfastWebhookError';
  }
}

// ─── Events ──────────────────────────────────────────────────────────────

/**
 * Documented webhook statuses are pending, delivered, partial_delivered,
 * cancelled and unknown. Anything else (including the `*_approval_pending`
 * family) is passed through as sent, lower-cased, never rewritten.
 */
export type WebhookDeliveryStatus = DeliveryStatus | (string & {});

export interface DeliveryStatusEvent {
  notification_type: 'delivery_status';
  consignment_id: number;
  invoice: string;
  status: WebhookDeliveryStatus;
  /** Taka. For `partial_delivered`, what the rider actually collected. */
  cod_amount: number;
  delivery_charge: number;
  tracking_message?: string;
  updated_at: string;
}

export interface TrackingUpdateEvent {
  notification_type: 'tracking_update';
  consignment_id: number;
  invoice: string;
  tracking_message: string;
  updated_at: string;
}

/** Events Steadfast lists but doesn't document a payload for yet. */
export type UntypedEventType =
  | 'consignment_update' // you changed a parcel (address, COD…)
  | 'return_list_accepted' // you confirmed receipt of a return list
  | 'payment_request' // a payout was requested
  | 'cancel_request' // a cancellation was raised or decided
  | 'return_request' // a return request was raised
  | 'pickup_request' // a pickup was requested
  | 'user_update'; // your account details changed

export interface UntypedEvent {
  notification_type: UntypedEventType | (string & {});
  raw: Record<string, unknown>;
}

export type SteadfastWebhookEvent = DeliveryStatusEvent | TrackingUpdateEvent | UntypedEvent;

export function isDeliveryStatusEvent(e: SteadfastWebhookEvent): e is DeliveryStatusEvent {
  return e.notification_type === 'delivery_status';
}

export function isTrackingUpdateEvent(e: SteadfastWebhookEvent): e is TrackingUpdateEvent {
  return e.notification_type === 'tracking_update';
}

// ─── Verification ────────────────────────────────────────────────────────

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Hex HMAC-SHA256 of the raw body, keyed with your auth token. */
export function signSteadfastWebhook(rawBody: string | Uint8Array, token: string): string {
  return createHmac('sha256', token).update(rawBody).digest('hex');
}

export interface VerifyOptions {
  /** Reject requests without `X-Signature`. Default false — see the module docs. */
  requireSignature?: boolean;
}

/**
 * Check `Authorization: Bearer` against the token (always) and `X-Signature`
 * against the raw body (when present, or always with `requireSignature`).
 * Constant-time.
 */
export function verifySteadfastWebhook(
  rawBody: string | Uint8Array,
  headers: Headers,
  token: string,
  { requireSignature = false }: VerifyOptions = {},
): boolean {
  if (!token) throw new Error('Steadfast webhook token is not configured');
  const bearer = /^Bearer\s+(.+)$/i.exec(header(headers, 'authorization')?.trim() ?? '')?.[1] ?? '';
  if (!safeEqual(bearer, token)) return false;
  const signature = header(headers, 'x-signature')?.trim().toLowerCase();
  if (!signature) return !requireSignature;
  return safeEqual(signature, signSteadfastWebhook(rawBody, token));
}

// ─── Parsing ─────────────────────────────────────────────────────────────

/** Taka as Steadfast sends it: a number or a numeric string. Refuses anything else. */
function taka(value: unknown, field: string, fail: (msg: string) => never): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fail(`unusable ${field} ${JSON.stringify(value)}`);
  return n;
}

/** Type a webhook body. Throws SteadfastWebhookError on a malformed payload. */
export function parseSteadfastWebhook(body: unknown): SteadfastWebhookEvent {
  const fail = (msg: string): never => {
    throw new SteadfastWebhookError('invalid_payload', msg);
  };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('body is not an object');
  const b = body as Record<string, unknown>;
  const type = b.notification_type;
  if (typeof type !== 'string' || !type) return fail('notification_type is missing');

  if (type !== 'delivery_status' && type !== 'tracking_update') {
    return { notification_type: type, raw: b };
  }

  const consignmentId = Number(b.consignment_id);
  if (b.consignment_id == null || !Number.isInteger(consignmentId)) fail('consignment_id is missing');
  if (typeof b.invoice !== 'string') fail('invoice is missing');
  const updatedAt = typeof b.updated_at === 'string' ? b.updated_at : '';

  if (type === 'tracking_update') {
    return {
      notification_type: 'tracking_update',
      consignment_id: consignmentId,
      invoice: b.invoice as string,
      tracking_message: typeof b.tracking_message === 'string' ? b.tracking_message : '',
      updated_at: updatedAt,
    };
  }

  const status = typeof b.status === 'string' ? b.status.trim().toLowerCase() : '';
  if (!status) fail('status is missing');
  return {
    notification_type: 'delivery_status',
    consignment_id: consignmentId,
    invoice: b.invoice as string,
    status,
    cod_amount: taka(b.cod_amount, 'cod_amount', fail),
    delivery_charge: taka(b.delivery_charge, 'delivery_charge', fail),
    ...(typeof b.tracking_message === 'string' ? { tracking_message: b.tracking_message } : {}),
    updated_at: updatedAt,
  };
}

// ─── One-call handler ────────────────────────────────────────────────────

export type WebhookResult =
  | {
      ok: true;
      event: SteadfastWebhookEvent;
      /** Store this; a retried event repeats it. Undefined if Steadfast omitted it. */
      idempotencyKey: string | undefined;
      httpStatus: 200;
      response: { status: 'success' };
    }
  | { ok: false; error: SteadfastWebhookError; httpStatus: 401 | 400; response: { status: 'error'; message: string } };

/**
 * Verify, parse, and get back the reply to send. Failures answer 4xx, which
 * Steadfast does not retry — a bad signature or payload won't improve.
 */
export function handleSteadfastWebhook(
  input: {
    rawBody: string | Uint8Array;
    headers: Headers;
    token: string;
  } & VerifyOptions,
): WebhookResult {
  const options = input.requireSignature === undefined ? {} : { requireSignature: input.requireSignature };
  if (!verifySteadfastWebhook(input.rawBody, input.headers, input.token, options)) {
    const error = new SteadfastWebhookError('unauthorized', 'bad or missing signature / bearer token');
    return { ok: false, error, httpStatus: 401, response: { status: 'error', message: 'Unauthorized' } };
  }
  try {
    const text = typeof input.rawBody === 'string' ? input.rawBody : Buffer.from(input.rawBody).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SteadfastWebhookError('invalid_payload', 'body is not JSON');
    }
    return {
      ok: true,
      event: parseSteadfastWebhook(parsed),
      idempotencyKey: header(input.headers, 'idempotency-key'),
      httpStatus: 200,
      response: { status: 'success' },
    };
  } catch (e) {
    if (!(e instanceof SteadfastWebhookError)) throw e;
    return { ok: false, error: e, httpStatus: 400, response: { status: 'error', message: e.message } };
  }
}
