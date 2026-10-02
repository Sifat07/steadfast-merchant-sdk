export type SteadfastErrorKind =
  /** Input rejected, by this SDK before sending or by Steadfast (HTTP 400/422). */
  | 'validation'
  /** Steadfast already has this invoice / pickup / return request. */
  | 'duplicate'
  /**
   * Missing, wrong or revoked keys (HTTP 401). Don't retry in a loop: ten
   * failures in five minutes locks the client out for an hour.
   */
  | 'auth'
  /** Authenticated but not allowed right now: inactive account or KYC (HTTP 403). */
  | 'forbidden'
  /** Unknown consignment, invoice, tracking code or record (HTTP 404). */
  | 'not_found'
  /** HTTP 429. Back off. */
  | 'rate_limited'
  /** 5xx, timeout or network failure. Safe to retry with the same invoice. */
  | 'unavailable'
  /** A response this SDK doesn't understand. Inspect `body`. */
  | 'unexpected';

export class SteadfastError extends Error {
  readonly kind: SteadfastErrorKind;
  /** HTTP status, when a response was received. */
  readonly httpStatus: number | undefined;
  /** Parsed response body, when there was one. */
  readonly body: unknown;

  constructor(
    kind: SteadfastErrorKind,
    message: string,
    details: { httpStatus?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'SteadfastError';
    this.kind = kind;
    this.httpStatus = details.httpStatus;
    this.body = details.body;
  }

  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'rate_limited';
  }
}

const DUPLICATE = /ALREADY_EXISTS|already been taken|already exists/i;

export function kindFor(status: number, body: unknown): SteadfastErrorKind {
  if (status === 409) return 'duplicate';
  if (status === 400 || status === 422) {
    return DUPLICATE.test(typeof body === 'string' ? body : JSON.stringify(body ?? '')) ? 'duplicate' : 'validation';
  }
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'unexpected';
}
