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

  it('rejects a body changed after signing (e.g. re-serialised JSON)', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    expect(verifySteadfastWebhook(JSON.stringify(JSON.parse(rawBody), null, 2), headers, TOKEN)).toBe(false);
  });

  it('rejects a wrong token, a missing signature or a missing bearer', () => {
    const { rawBody, headers } = signed(deliveryStatus, 'someone-else');
    expect(verifySteadfastWebhook(rawBody, headers, TOKEN)).toBe(false);
    const good = signed(deliveryStatus);
    expect(verifySteadfastWebhook(good.rawBody, { ...good.headers, 'x-signature': undefined }, TOKEN)).toBe(false);
    expect(verifySteadfastWebhook(good.rawBody, { ...good.headers, authorization: undefined }, TOKEN)).toBe(false);
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

  it.each([
    [null, /not an object/],
    [[], /not an object/],
    [{ ...deliveryStatus, notification_type: undefined }, /notification_type/],
    [{ ...deliveryStatus, consignment_id: undefined }, /consignment_id/],
    [{ ...deliveryStatus, invoice: 5 }, /invoice/],
    [{ ...deliveryStatus, status: 'teleported' }, /unknown status/],
  ])('rejects malformed payload %#', (body, msg) => {
    expect(() => parseSteadfastWebhook(body)).toThrow(msg);
  });
});

describe('handleSteadfastWebhook', () => {
  it('answers 200 with the event and idempotency key for a good request', () => {
    const result = handleSteadfastWebhook({ ...signed(deliveryStatus), token: TOKEN });
    expect(result).toMatchObject({ ok: true, httpStatus: 200, idempotencyKey: 'evt-1', event: { status: 'delivered' } });
  });

  it('answers 401 for a bad signature without parsing', () => {
    const { rawBody, headers } = signed(deliveryStatus);
    const result = handleSteadfastWebhook({ rawBody: `${rawBody} `, headers, token: TOKEN });
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('answers 400 for a signed but malformed body', () => {
    expect(handleSteadfastWebhook({ ...signed({ nope: true }), token: TOKEN })).toMatchObject({ ok: false, httpStatus: 400 });
    const rawBody = 'not json';
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-signature': signSteadfastWebhook(rawBody, TOKEN) };
    expect(handleSteadfastWebhook({ rawBody, headers, token: TOKEN })).toMatchObject({ ok: false, httpStatus: 400 });
  });
});
