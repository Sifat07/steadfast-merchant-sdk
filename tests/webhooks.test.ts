import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  handleSteadfastWebhook,
  parseSteadfastWebhook,
  signSteadfastWebhook,
  verifySteadfastWebhook,
} from '../src/webhooks';

const TOKEN = 'merchant-chosen_token.1';

// The sample from Steadfast's webhook page.
const deliveryStatus = {
  notification_type: 'delivery_status',
  consignment_id: 12345,
  invoice: 'INV-67890',
  cod_amount: 1500.0,
  status: 'Delivered',
  delivery_charge: 100.0,
  tracking_message: 'Your package has been delivered successfully.',
  updated_at: '2025-03-02 12:45:30',
};

function signed(body: unknown, token = TOKEN) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-signature': createHmac('sha256', token).update(rawBody).digest('hex'),
      'idempotency-key': 'evt-1',
      'user-agent': 'Steadfast-Webhook/1.0',
    },
  };
}

describe('verifySteadfastWebhook', () => {
  it('matches the HMAC recipe from Steadfast’s docs', () => {
    expect(signSteadfastWebhook('{"a":1}', 'k')).toBe(createHmac('sha256', 'k').update('{"a":1}').digest('hex'));
  });

  it('accepts a correctly signed request, with headers in any case', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    expect(verifySteadfastWebhook(rawBody, headers, TOKEN)).toBe(true);
    const upper = { Authorization: headers.authorization, 'X-Signature': headers['x-signature'].toUpperCase() };
    expect(verifySteadfastWebhook(Buffer.from(rawBody), upper, TOKEN)).toBe(true);
  });

  it('with requireSignature, rejects a body changed after signing (e.g. re-serialised JSON)', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    const reserialised = JSON.stringify(JSON.parse(rawBody), null, 2);
    expect(verifySteadfastWebhook(reserialised, headers, TOKEN, { requireSignature: true })).toBe(false);
    expect(verifySteadfastWebhook(reserialised, headers, TOKEN)).toBe(true);
  });

  it('rejects a wrong token or a missing bearer', () => {
    const { rawBody, headers } = signed(deliveryStatus, 'someone-else');
    expect(verifySteadfastWebhook(rawBody, headers, TOKEN)).toBe(false);
    const good = signed(deliveryStatus);
    expect(verifySteadfastWebhook(good.rawBody, { ...good.headers, authorization: undefined }, TOKEN)).toBe(false);
  });

  it('accepts bearer-only by default, but not with requireSignature', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    const bearerOnly = { ...headers, 'x-signature': undefined };
    expect(verifySteadfastWebhook(rawBody, bearerOnly, TOKEN)).toBe(true);
    expect(verifySteadfastWebhook(rawBody, bearerOnly, TOKEN, { requireSignature: true })).toBe(false);
    expect(verifySteadfastWebhook(rawBody, headers, TOKEN, { requireSignature: true })).toBe(true);
  });

  it('does not reject a wrong signature unless requireSignature is set', () => {
    // The HMAC is keyed with the bearer itself, so it authenticates nothing
    // extra, and a 401 is never retried: enforcing a misread recipe would drop
    // every event.
    const { rawBody, headers } = signed(deliveryStatus);
    const wrong = { ...headers, 'x-signature': 'ab'.repeat(32) };
    expect(verifySteadfastWebhook(rawBody, wrong, TOKEN)).toBe(true);
    expect(verifySteadfastWebhook(rawBody, wrong, TOKEN, { requireSignature: true })).toBe(false);
  });

  it('refuses to run without a configured token', () => {
    expect(() => verifySteadfastWebhook('{}', {}, '')).toThrow(/not configured/);
  });
});

describe('parseSteadfastWebhook', () => {
  it('parses a delivery_status event and lower-cases the status', () => {
    expect(parseSteadfastWebhook(deliveryStatus)).toMatchObject({
      notification_type: 'delivery_status',
      status: 'delivered',
      consignment_id: 12345,
      cod_amount: 1500,
    });
  });

  it('reads a body without notification_type as a delivery status', () => {
    // Steadfast's own Laravel package documents the push without the field,
    // and a 400 is never retried: rejecting it would drop the event.
    const { notification_type: _type, ...untyped } = deliveryStatus;
    expect(parseSteadfastWebhook(untyped)).toMatchObject({
      notification_type: 'delivery_status',
      status: 'delivered',
      invoice: 'INV-67890',
    });
    expect(() => parseSteadfastWebhook({ ...untyped, status: undefined })).toThrow(/status is missing/);
  });

  it('passes a fractional cod_amount through as sent', () => {
    expect(parseSteadfastWebhook({ ...deliveryStatus, cod_amount: '10.5' })).toMatchObject({ cod_amount: 10.5 });
  });

  it('parses a tracking_update event', () => {
    const event = parseSteadfastWebhook({
      notification_type: 'tracking_update',
      consignment_id: '12345',
      invoice: 'INV-67890',
      tracking_message: 'Parcel received at Dhanmondi hub.',
      updated_at: '2025-03-02 13:15:00',
    });
    expect(event).toMatchObject({ notification_type: 'tracking_update', consignment_id: 12345 });
  });

  it.each(['consignment_update', 'return_list_accepted', 'payment_request', 'cancel_request', 'return_request', 'pickup_request', 'user_update', 'brand_new_event'])(
    'passes %s through with its raw body',
    (type) => {
      expect(parseSteadfastWebhook({ notification_type: type, x: 1 })).toEqual({
        notification_type: type,
        raw: { notification_type: type, x: 1 },
      });
    },
  );

  it('keeps statuses as sent instead of rewriting or rejecting them', () => {
    for (const status of ['delivered_approval_pending', 'hold', 'some_future_status']) {
      expect(parseSteadfastWebhook({ ...deliveryStatus, status })).toMatchObject({ status });
    }
  });

  it('accepts numeric-string amounts', () => {
    expect(parseSteadfastWebhook({ ...deliveryStatus, cod_amount: '1500.00', delivery_charge: '100' })).toMatchObject({
      cod_amount: 1500,
      delivery_charge: 100,
    });
  });

  it.each([
    [null, /not an object/],
    [[], /not an object/],
    [{ ...deliveryStatus, notification_type: 7 }, /notification_type/],
    [{ ...deliveryStatus, notification_type: '' }, /notification_type/],
    [{ ...deliveryStatus, consignment_id: undefined }, /consignment_id/],
    [{ ...deliveryStatus, invoice: 5 }, /invoice/],
    [{ ...deliveryStatus, status: '' }, /status is missing/],
    [{ ...deliveryStatus, cod_amount: 'abc' }, /unusable cod_amount/],
    [{ ...deliveryStatus, cod_amount: -5 }, /unusable cod_amount/],
    [{ ...deliveryStatus, delivery_charge: {} }, /unusable delivery_charge/],
  ])('rejects malformed payload %#', (body, msg) => {
    expect(() => parseSteadfastWebhook(body)).toThrow(msg);
  });
});

describe('handleSteadfastWebhook', () => {
  it('answers 200 with the event, idempotency key and signature check for a good request', () => {
    const result = handleSteadfastWebhook({ ...signed(deliveryStatus), token: TOKEN });
    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      idempotencyKey: 'evt-1',
      signature: 'valid',
      event: { status: 'delivered' },
    });
  });

  it('answers 200 for a bad or missing signature, and reports it', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    expect(handleSteadfastWebhook({ rawBody: `${rawBody} `, headers, token: TOKEN })).toMatchObject({
      ok: true,
      httpStatus: 200,
      signature: 'invalid',
    });
    expect(handleSteadfastWebhook({ rawBody, headers: { ...headers, 'x-signature': undefined }, token: TOKEN })).toMatchObject({
      ok: true,
      signature: 'absent',
    });
  });

  it('answers 401 for a bad signature with requireSignature, without parsing', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    const result = handleSteadfastWebhook({ rawBody: `${rawBody} `, headers, token: TOKEN, requireSignature: true });
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('answers 401 for a wrong bearer', () => {
    const { rawBody, headers } = signed(deliveryStatus, 'someone-else');
    expect(handleSteadfastWebhook({ rawBody, headers, token: TOKEN })).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('answers 400 for a signed but malformed body', () => {
    expect(handleSteadfastWebhook({ ...signed({ nope: true }), token: TOKEN })).toMatchObject({ ok: false, httpStatus: 400 });
    const rawBody = 'not json';
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-signature': signSteadfastWebhook(rawBody, TOKEN) };
    expect(handleSteadfastWebhook({ rawBody, headers, token: TOKEN })).toMatchObject({ ok: false, httpStatus: 400 });
  });
});
