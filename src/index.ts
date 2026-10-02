/**
 * Steadfast Merchant SDK (unofficial)
 *
 * @example
 * ```ts
 * import { SteadfastClient } from 'steadfast-merchant-sdk';
 *
 * const steadfast = new SteadfastClient({
 *   apiKey: process.env.STEADFAST_API_KEY!,
 *   secretKey: process.env.STEADFAST_SECRET_KEY!,
 * });
 *
 * const consignment = await steadfast.createOrder({
 *   invoice: 'ORD-1001',
 *   recipient_name: 'Rahim Uddin',
 *   recipient_phone: '01712345678',
 *   recipient_address: 'House 12, Road 5, Dhanmondi, Dhaka',
 *   cod_amount: 1250,
 * });
 * ```
 */
export { SteadfastClient, DEFAULT_BASE_URL } from './client';
export { SteadfastError, type SteadfastErrorKind } from './errors';
export { normalizeBdPhone } from './phone';
export {
  BULK_ORDER_LIMIT,
  DELIVERY_STATUSES,
  DeliveryType,
  FIELD_LIMITS,
  RETURN_STATUSES,
  isApprovalPending,
  isDeliveryStatus,
  isFinalStatus,
  isReturnReceived,
  isReturnStatus,
} from './types';
export type {
  BulkOrderResult,
  CallOptions,
  Consignment,
  CreateOrderRequest,
  CreatePickupRequest,
  DeliveryStatus,
  FraudScore,
  Page,
  Payout,
  PickupRequest,
  PoliceStation,
  ReturnRequest,
  ReturnRequestStatus,
  ReturnRequestTarget,
  ReturnStatus,
  SteadfastConfig,
  TrackingEvent,
  VolumeBand,
} from './types';
