import { SteadfastError, kindFor } from './errors';
import { normalizeBdPhone } from './phone';
import {
  BULK_ORDER_LIMIT,
  FIELD_LIMITS,
  isDeliveryStatus,
  isReturnStatus,
  type BulkOrderResult,
  type CallOptions,
  type Consignment,
  type CreateOrderRequest,
  type CreatePickupRequest,
  type DeliveryStatus,
  type FraudScore,
  type Page,
  type PickupRequest,
  type PoliceStation,
  type Payout,
  type ReturnRequest,
  type ReturnRequestTarget,
  type ReturnStatus,
  type SteadfastConfig,
  type TrackingEvent,
} from './types';

export const DEFAULT_BASE_URL = 'https://portal.packzy.com/api/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const INVOICE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Client for the Steadfast (Packzy) merchant API.
 *
 * No automatic retries. Retrying a create is safe as long as you reuse the
 * same invoice: Steadfast refuses a duplicate (kind `duplicate`), so a retry
 * can't book the parcel twice. Status answers are cached by Steadfast for 60 s,
 * so polling faster than that is wasted — use webhooks.
 */
export class SteadfastClient {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SteadfastConfig) {
    if (!config.apiKey || !config.secretKey) {
      throw new SteadfastError('validation', 'apiKey and secretKey are required');
    }
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new SteadfastError('validation', 'No fetch implementation available; pass config.fetch');
    }
  }

  /** Reachability check. Needs no keys, so a failure here is network, not credentials. */
  async ping(opts?: CallOptions): Promise<void> {
    await this.request('GET', '/ping', opts, undefined, { auth: false });
  }

  // ─── Orders ────────────────────────────────────────────────────────────

  /** Book one parcel. On a live account this books a real pickup. */
  async createOrder(order: CreateOrderRequest, opts?: CallOptions): Promise<Consignment> {
    const body = await this.request('POST', '/create_order', opts, validateOrder(order));
    const consignment = (body as { consignment?: Consignment }).consignment;
    if (!consignment) throw unexpected('create_order response has no consignment', body);
    return consignment;
  }

  /**
   * Book up to 500 parcels. Uses the `extended` endpoint, which returns error
   * messages instead of codes and honours per-order optional fields. Results
   * come back in the order given, one per order. Partial success is normal:
   * re-send only the failures, keeping their invoices.
   *
   * An order that fails this SDK's validation does not fail the batch: it comes
   * back as `{ ok: false, errors }` and is not sent. If none are valid, nothing
   * is sent at all. Only request-level problems throw: an empty list, more than
   * 500 orders, or a duplicate invoice.
   */
  async createBulkOrders(orders: CreateOrderRequest[], opts?: CallOptions): Promise<BulkOrderResult[]> {
    if (orders.length === 0) throw new SteadfastError('validation', 'orders is empty');
    if (orders.length > BULK_ORDER_LIMIT) {
      throw new SteadfastError('validation', `at most ${BULK_ORDER_LIMIT} orders per bulk call (got ${orders.length})`);
    }
    const seen = new Set<string>();
    const checked = orders.map((o, i) => {
      const key = o.invoice?.trim();
      if (key) {
        if (seen.has(key)) throw new SteadfastError('validation', `duplicate invoice at index ${i}`);
        seen.add(key);
      }
      try {
        return { order: validateOrder(o) };
      } catch (e) {
        if (!(e instanceof SteadfastError)) throw e;
        return { failed: { ok: false, invoice: key ?? '', errors: [e.message] } as BulkOrderResult };
      }
    });
    const data = checked.flatMap((c) => (c.order ? [c.order] : []));
    if (data.length === 0) return checked.map((c) => c.failed!);
    let body: unknown;
    try {
      body = await this.request('POST', '/create_order/bulk-order/extended', opts, { data });
    } catch (e) {
      // The 2026 guide documents `data` as an array; Steadfast's own Laravel
      // package sends it JSON-encoded. A 400 means the request wasn't
      // understood, so nothing was booked — retry once in the other encoding.
      if (!(e instanceof SteadfastError) || e.httpStatus !== 400 || e.kind !== 'validation') throw e;
      body = await this.request('POST', '/create_order/bulk-order/extended', opts, { data: JSON.stringify(data) });
    }
    const rows = Array.isArray(body) ? body : (body as { data?: unknown }).data;
    if (!Array.isArray(rows)) throw unexpected('bulk-order response has no data list', body);
    const sent = new Map(rows.map(toBulkResult).map((r) => [r.invoice, r]));
    return checked.map(
      (c) =>
        c.failed ??
        sent.get(c.order!.invoice) ?? { ok: false, invoice: c.order!.invoice, errors: ['no result returned for this order'] },
    );
  }

  // ─── Status ────────────────────────────────────────────────────────────

  /**
   * Where a parcel is now, by the `consignment_id` Steadfast returned at
   * booking. Answers are cached by Steadfast for 60 s. For a parcel that is
   * coming back, use `getStatusWithReturnByConsignmentId` instead.
   */
  getStatusByConsignmentId(consignmentId: number | string, opts?: CallOptions): Promise<DeliveryStatus> {
    return this.status(`/status_by_cid/${seg(consignmentId)}`, opts);
  }

  /** If the same invoice was somehow booked twice, this answers for the latest. */
  getStatusByInvoice(invoice: string, opts?: CallOptions): Promise<DeliveryStatus> {
    return this.status(`/status_by_invoice/${seg(invoice)}`, opts);
  }

  /** Same answer as `getStatusByConsignmentId`, by the customer-facing tracking code. */
  getStatusByTrackingCode(trackingCode: string, opts?: CallOptions): Promise<DeliveryStatus> {
    return this.status(`/status_by_trackingcode/${seg(trackingCode)}`, opts);
  }

  /**
   * Like `getStatusByConsignmentId`, but for a parcel coming back it says how
   * far back it has got. The only way to learn a return is physically received
   * (`isReturnReceived`) — use it when reconciling stock.
   */
  async getStatusWithReturnByConsignmentId(
    consignmentId: number | string,
    opts?: CallOptions,
  ): Promise<DeliveryStatus | ReturnStatus> {
    const body = await this.request('GET', `/status_with_return_status_by_cid/${seg(consignmentId)}`, opts);
    const status = (body as { delivery_status?: unknown }).delivery_status;
    if (!isDeliveryStatus(status) && !isReturnStatus(status)) {
      throw unexpected(`unrecognised delivery_status ${JSON.stringify(status)}`, body);
    }
    return status;
  }

  /** Every step the parcel has been through — what to show "where is my order?". */
  async getTrackingByInvoice(invoice: string, opts?: CallOptions): Promise<TrackingEvent[]> {
    const body = await this.request('GET', `/trackings_by_invoice/${seg(invoice)}`, opts);
    const tracking = (body as { tracking?: unknown }).tracking;
    if (!Array.isArray(tracking)) throw unexpected('trackings_by_invoice response has no tracking list', body);
    return tracking as TrackingEvent[];
  }

  // ─── Pickups ───────────────────────────────────────────────────────────

  /**
   * Ask a rider to collect. Safe to retry: a second request for the same
   * address while one is pending is refused (kind `duplicate`), not doubled.
   */
  async createPickupRequest(req: CreatePickupRequest, opts?: CallOptions): Promise<PickupRequest> {
    const phone = normalizeBdPhone(req.contact_number);
    if (!phone) throw new SteadfastError('validation', 'contact_number is not a valid BD mobile number');
    checkLength('address', req.address, 255);
    if (req.note !== undefined) checkLength('note', req.note, 500);
    const body = await this.request('POST', '/create_pickup_request', opts, { ...req, contact_number: phone });
    return unwrapObject<PickupRequest>(body, 'create_pickup_request');
  }

  // ─── Returns ───────────────────────────────────────────────────────────

  /**
   * Ask for a parcel to be brought back before it's delivered. Refused
   * (`validation`) for a parcel already delivered or already coming back, and
   * (`duplicate`) while an earlier request for it is still open.
   */
  async createReturnRequest(target: ReturnRequestTarget, reason?: string, opts?: CallOptions): Promise<ReturnRequest> {
    const keys = (['consignment_id', 'invoice', 'tracking_code'] as const).filter((k) => k in target);
    if (keys.length !== 1) {
      throw new SteadfastError('validation', 'pass exactly one of consignment_id, invoice or tracking_code');
    }
    if (reason !== undefined) checkLength('reason', reason, 500);
    const body = await this.request('POST', '/create_return_request', opts, {
      ...target,
      ...(reason === undefined ? {} : { reason }),
    });
    return unwrapObject<ReturnRequest>(body, 'create_return_request');
  }

  /**
   * One return request by the `id` from `createReturnRequest`. Steadfast's
   * guide says the answer includes the parcel it's about; the extra fields
   * aren't typed yet, so they're present at runtime but not in `ReturnRequest`.
   */
  async getReturnRequest(id: number, opts?: CallOptions): Promise<ReturnRequest> {
    const body = await this.request('GET', `/get_return_request/${seg(id)}`, opts);
    return unwrapObject<ReturnRequest>(body, 'get_return_request');
  }

  /** Newest first, ten per page. */
  async getReturnRequests(page = 1, opts?: CallOptions): Promise<Page<ReturnRequest>> {
    const body = await this.request('GET', `/get_return_requests${pageQuery(page)}`, opts);
    return { items: listFrom<ReturnRequest>(body, ['data', 'return_requests'], 'get_return_requests'), page };
  }

  // ─── Balance and payments ──────────────────────────────────────────────

  /** Delivered COD minus delivery and collection charges: what you could request a payout of now. */
  async getBalance(opts?: CallOptions): Promise<number> {
    const body = await this.request('GET', '/get_balance', opts);
    const balance = Number((body as { current_balance?: unknown }).current_balance);
    if (!Number.isFinite(balance)) throw unexpected('get_balance response has no current_balance', body);
    return balance;
  }

  /** Payouts made to you, ten per page. */
  async getPayments(page = 1, opts?: CallOptions): Promise<Page<Payout>> {
    const body = await this.request('GET', `/payments${pageQuery(page)}`, opts);
    return { items: listFrom<Payout>(body, ['payments', 'data'], 'payments'), page };
  }

  /**
   * One payout with every parcel it settled — how you reconcile against your
   * orders. Pass `SFC-88213` or `88213`. Unverified shape: returned as sent.
   */
  async getPayment(paymentId: string | number, opts?: CallOptions): Promise<Record<string, unknown>> {
    const digits = String(paymentId).replace(/\D/g, '');
    if (!digits) throw new SteadfastError('validation', 'payment id has no digits');
    return (await this.request('GET', `/payments/${digits}`, opts)) as Record<string, unknown>;
  }

  // ─── Lookups ───────────────────────────────────────────────────────────

  /** Every thana Steadfast delivers to. Changes rarely: cache it. */
  async getPoliceStations(opts?: CallOptions): Promise<PoliceStation[]> {
    const body = await this.request('GET', '/police_stations', opts);
    return listFrom<PoliceStation>(body, ['data', 'police_stations'], 'police_stations');
  }

  /**
   * A customer's delivery record across all merchants. A signal, not a
   * verdict. Rate-limited per merchant against your own booking volume.
   */
  async getFraudScore(phone: string, opts?: CallOptions): Promise<FraudScore> {
    const normalised = normalizeBdPhone(phone);
    if (!normalised) throw new SteadfastError('validation', 'phone is not a valid BD mobile number');
    const body = await this.request('GET', `/fraud_check/score/${normalised}`, opts);
    const { status: _status, ...score } = body as FraudScore & { status?: unknown };
    return score as FraudScore;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async status(path: string, opts?: CallOptions): Promise<DeliveryStatus> {
    const body = await this.request('GET', path, opts);
    const status = (body as { delivery_status?: unknown }).delivery_status;
    if (!isDeliveryStatus(status)) throw unexpected(`unrecognised delivery_status ${JSON.stringify(status)}`, body);
    return status;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts?: CallOptions,
    json?: unknown,
    { auth = true }: { auth?: boolean } = {},
  ): Promise<unknown> {
    const { signal, cleanup } = combineSignals(this.timeoutMs, opts?.signal);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(auth ? { 'Api-Key': this.apiKey, 'Secret-Key': this.secretKey } : {}),
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        // Api-Key / Secret-Key are custom headers, which fetch forwards to a
        // redirect target. Steadfast doesn't redirect its API; refuse to.
        redirect: 'error',
        signal,
      });
    } catch (cause) {
      const aborted = opts?.signal?.aborted;
      throw new SteadfastError('unavailable', aborted ? 'request aborted' : `request to ${path} failed`, { cause });
    } finally {
      cleanup();
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }

    if (!res.ok) {
      throw new SteadfastError(kindFor(res.status, body), messageFrom(body) ?? `HTTP ${res.status} from ${path}`, {
        httpStatus: res.status,
        body,
      });
    }
    if (!auth) return body;
    if (typeof body !== 'object' || body === null) {
      // A 2xx that isn't JSON (a proxy or CDN page) is no verdict: a create
      // may or may not have landed. Retrying with the same invoice is safe.
      throw new SteadfastError('unavailable', `non-JSON ${res.status} response from ${path}`, {
        httpStatus: res.status,
        body,
      });
    }

    // Some endpoints answer HTTP 200 with the real code in the body.
    const inner = (body as { status?: unknown }).status;
    if (typeof inner === 'number' && inner >= 400) {
      throw new SteadfastError(kindFor(inner, body), messageFrom(body) ?? `status ${inner} from ${path}`, {
        httpStatus: res.status,
        body,
      });
    }
    return body;
  }
}

function validateOrder(order: CreateOrderRequest): CreateOrderRequest {
  const fail = (msg: string): never => {
    throw new SteadfastError('validation', msg);
  };
  const invoice = order.invoice?.trim() ?? '';
  if (!invoice) fail('invoice is required');
  if (!INVOICE_PATTERN.test(invoice)) fail('invoice may only contain letters, digits, - and _');
  if (invoice.length > FIELD_LIMITS.invoice) fail(`invoice is longer than ${FIELD_LIMITS.invoice} characters`);
  if (!order.recipient_name?.trim()) fail('recipient_name is required');
  if (!order.recipient_address?.trim()) fail('recipient_address is required');
  checkLength('recipient_name', order.recipient_name, FIELD_LIMITS.recipient_name);
  checkLength('recipient_address', order.recipient_address, FIELD_LIMITS.recipient_address);
  if (order.note !== undefined) checkLength('note', order.note, FIELD_LIMITS.note);
  if (order.item_description !== undefined) {
    checkLength('item_description', order.item_description, FIELD_LIMITS.item_description);
  }
  const phone = normalizeBdPhone(order.recipient_phone ?? '') ?? fail('recipient_phone is not a valid BD mobile number');
  if (!Number.isInteger(order.cod_amount) || order.cod_amount < 0 || order.cod_amount > FIELD_LIMITS.cod_amount) {
    fail(`cod_amount must be a whole number of taka from 0 to ${FIELD_LIMITS.cod_amount}`);
  }
  if (order.total_lot !== undefined && (!Number.isInteger(order.total_lot) || order.total_lot < 1)) {
    fail('total_lot must be a positive whole number');
  }
  const alt = order.alternative_phone
    ? (normalizeBdPhone(order.alternative_phone) ?? fail('alternative_phone is not a valid BD mobile number'))
    : undefined;
  return { ...order, invoice, recipient_phone: phone, ...(alt === undefined ? {} : { alternative_phone: alt }) };
}

function checkLength(field: string, value: string, max: number): void {
  if (value.length > max) {
    throw new SteadfastError('validation', `${field} is longer than ${max} characters (Steadfast would truncate it)`);
  }
}

function toBulkResult(row: unknown): BulkOrderResult {
  const r = row as Record<string, unknown>;
  const invoice = String(r.invoice ?? '');
  if (r.status === 'success' && r.consignment_id != null) {
    return {
      ok: true,
      invoice,
      consignment_id: Number(r.consignment_id),
      tracking_code: String(r.tracking_code ?? ''),
      ...(typeof r.tracking_link === 'string' ? { tracking_link: r.tracking_link } : {}),
    };
  }
  return { ok: false, invoice, errors: errorList(r.error) };
}

/** Bulk errors arrive as an array, or as a JSON-encoded array in a string. */
function errorList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // plain string
    }
    return [raw];
  }
  return ['unknown error'];
}

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function messageFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { message, errors } = body as { message?: unknown; errors?: unknown };
  if (errors && typeof errors === 'object') {
    const first = Object.values(errors as Record<string, unknown>).flat()[0];
    if (typeof first === 'string') return typeof message === 'string' ? `${message}: ${first}` : first;
  }
  return typeof message === 'string' ? message : undefined;
}

function unwrapObject<T>(body: unknown, what: string): T {
  const inner = (body as { data?: unknown }).data;
  const obj = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : body;
  if (typeof (obj as { id?: unknown }).id !== 'number') throw unexpected(`${what} response has no id`, body);
  return obj as T;
}

/** Find the list in a response that may be a bare array or wrapped under one of `keys`. */
function listFrom<T>(body: unknown, keys: string[], what: string): T[] {
  if (Array.isArray(body)) return body as T[];
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
    // Laravel paginator: { data: { data: [...] } }
    const nested = (value as { data?: unknown } | undefined)?.data;
    if (Array.isArray(nested)) return nested as T[];
  }
  throw unexpected(`${what} response has no list`, body);
}

function pageQuery(page: number): string {
  if (!Number.isInteger(page) || page < 1) throw new SteadfastError('validation', 'page must be a positive whole number');
  return page === 1 ? '' : `?page=${page}`;
}

function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

function unexpected(message: string, body: unknown): SteadfastError {
  return new SteadfastError('unexpected', message, { body });
}
