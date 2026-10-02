/**
 * Request/response shapes for the Steadfast (Packzy) merchant API v1, from
 * Steadfast's in-panel "API guide" (2026). Shapes the guide doesn't show are
 * typed loosely and marked "unverified"; `scripts/smoke.mjs` prints the raw
 * bodies so they can be confirmed against a live account.
 */

export interface SteadfastConfig {
  apiKey: string;
  secretKey: string;
  /** Defaults to `https://portal.packzy.com/api/v1`. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 30 000 ms. */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  signal?: AbortSignal;
}

// ─── Orders ──────────────────────────────────────────────────────────────

export enum DeliveryType {
  HOME = 0,
  POINT = 1,
}

/**
 * Steadfast truncates over-long values instead of rejecting them, so the SDK
 * enforces these limits itself and fails loudly.
 */
export const FIELD_LIMITS = {
  invoice: 100,
  recipient_name: 100,
  recipient_address: 490,
  note: 480,
  item_description: 255,
  cod_amount: 1_000_000,
} as const;

export interface CreateOrderRequest {
  /**
   * Your own order number: letters, digits, `-` and `_` only, up to 100.
   * Steadfast refuses a repeated invoice, which is what makes a retry safe.
   */
  invoice: string;
  recipient_name: string;
  /** 11-digit BD mobile. Other formats are normalised with `normalizeBdPhone`. */
  recipient_phone: string;
  alternative_phone?: string;
  recipient_email?: string;
  recipient_address: string;
  /** Whole taka to collect. 0 for prepaid. Max 1,000,000. */
  cod_amount: number;
  /** Instructions for the rider. */
  note?: string;
  item_description?: string;
  /** Number of items. Defaults to 1. */
  total_lot?: number;
  delivery_type?: DeliveryType;
}

export interface Consignment {
  consignment_id: number;
  invoice: string;
  tracking_code: string;
  tracking_link?: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  recipient_email: string | null;
  alternative_phone: string | null;
  item_description: string | null;
  total_lot: number;
  cod_amount: number;
  /** Every new parcel starts at `in_review`. */
  status: DeliveryStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** Max orders per bulk call. */
export const BULK_ORDER_LIMIT = 500;

/** One bulk row, in the order you sent them. Partial success is normal. */
export type BulkOrderResult =
  | { ok: true; invoice: string; consignment_id: number; tracking_code: string; tracking_link?: string }
  | { ok: false; invoice: string; errors: string[] };

// ─── Status ──────────────────────────────────────────────────────────────

export const DELIVERY_STATUSES = [
  'pending',
  'in_review',
  'hold',
  'delivered_approval_pending',
  'partial_delivered_approval_pending',
  'cancelled_approval_pending',
  'unknown_approval_pending',
  'delivered',
  'partial_delivered',
  'cancelled',
  'exceptional',
  'unknown',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Only from `getStatusWithReturnByConsignmentId`, and only for a parcel that
 * didn't fully arrive. `*_received` is the one signal that the goods are back.
 */
export const RETURN_STATUSES = [
  'partial_delivered_return_processing',
  'partial_delivered_return_rider_assigned',
  'partial_delivered_return_received',
  'cancelled_return_processing',
  'cancelled_return_rider_assigned',
  'cancelled_return_received',
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/**
 * `*_approval_pending` is the rider's word, not Steadfast's. Don't settle
 * stock, refunds or payouts on it — wait for the confirmed status.
 */
export function isApprovalPending(status: DeliveryStatus): boolean {
  return status.endsWith('_approval_pending');
}

/** Confirmed outcome: delivered, partially delivered or cancelled. */
export function isFinalStatus(status: DeliveryStatus): boolean {
  return status === 'delivered' || status === 'partial_delivered' || status === 'cancelled';
}

/** The returned goods are physically back with you. */
export function isReturnReceived(status: DeliveryStatus | ReturnStatus): boolean {
  return status.endsWith('_return_received');
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isReturnStatus(value: unknown): value is ReturnStatus {
  return typeof value === 'string' && (RETURN_STATUSES as readonly string[]).includes(value);
}

export interface TrackingEvent {
  consignment_id: number;
  tracking_type: number;
  text: string;
  created_at: string;
}

// ─── Pickups ─────────────────────────────────────────────────────────────

export interface CreatePickupRequest {
  /** One of your saved pickup addresses (Pickup Addresses page). */
  address_id: number;
  /** The thana, from `getPoliceStations()`. */
  police_station_id: number;
  /** Up to 255 characters. */
  address: string;
  /** Who the rider should call. 11-digit BD mobile. */
  contact_number: string;
  /** Up to 500 characters. */
  note?: string;
  /** Roughly how many parcels are waiting. */
  estim_qty?: number;
}

export interface PickupRequest {
  id: number;
  user_id: number;
  user_address_id: number;
  police_station_id: number;
  pickup_location: string;
  contact_number: string;
  note: string | null;
  estim_qty: number | null;
  req_status: number;
  created_at: string;
}

// ─── Returns ─────────────────────────────────────────────────────────────

export type ReturnRequestStatus = 'pending' | 'approved' | 'processing' | 'completed' | 'cancelled';

/** Identify the consignment by exactly one of these. */
export type ReturnRequestTarget =
  | { consignment_id: number }
  | { invoice: string }
  | { tracking_code: string };

export interface ReturnRequest {
  id: number;
  user_id: number;
  consignment_id: number;
  reason: string | null;
  status: ReturnRequestStatus;
  created_at: string;
  updated_at: string;
}

// ─── Payments ────────────────────────────────────────────────────────────

export interface Payout {
  payment_id: string;
  amount: number;
  method: string;
  due_bills: number;
  paid_bills: number;
  charges: number;
  total: number;
  status_label: string;
  created_at: string;
  ready_at: string | null;
  paid_at: string | null;
}

// ─── Lookups ─────────────────────────────────────────────────────────────

/** Unverified: the guide doesn't show this shape. */
export interface PoliceStation {
  id: number;
  name: string;
  [key: string]: unknown;
}

export type VolumeBand = 'none' | 'low' | 'medium' | 'high' | 'very_high';

/**
 * A customer's delivery record across every merchant. A signal, not a verdict.
 * Ratios are whole percents of *finished* parcels and are `null` — not 0 —
 * when nothing has finished yet. Don't render null as a clean record.
 */
export interface FraudScore {
  phone: string;
  delivery_ratio: number | null;
  cancellation_ratio: number | null;
  volume_band: VolumeBand;
  total_reports: number;
  /** e.g. `{ no_response: 3, refused: 1 }`, worst first. */
  fraud_categories: Record<string, number> | [];
  /** Always null while Steadfast has scoring disabled. */
  score: number | null;
  level: string | null;
  reasons: string[];
  scoring_disabled: boolean;
  doubtful_reports: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
}
