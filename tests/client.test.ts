import { describe, expect, it, vi } from 'vitest';
import { SteadfastClient, normalizeBdPhone } from '../src';

type Reply = { status?: number; body: unknown };

function client(...replies: Reply[]) {
  const fetchMock = vi.fn(async () => {
    const r = replies.shift() ?? { body: {} };
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  const sf = new SteadfastClient({ apiKey: 'k', secretKey: 's', fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
    return { url, init, json: init.body ? JSON.parse(init.body as string) : undefined };
  };
  return { sf, fetchMock, call };
}

const order = {
  invoice: 'INV-1',
  recipient_name: 'Rahim',
  recipient_phone: '+880 1712-345678',
  recipient_address: 'Dhanmondi, Dhaka',
  cod_amount: 500,
};

const consignment = {
  consignment_id: 1424107,
  invoice: 'INV-1',
  tracking_code: '15BAEB8A',
  recipient_name: 'Rahim',
  recipient_phone: '01712345678',
  recipient_address: 'Dhanmondi, Dhaka',
  cod_amount: 500,
  status: 'in_review',
  created_at: '2026-10-02T10:00:00.000000Z',
  updated_at: '2026-10-02T10:00:00.000000Z',
};

describe('SteadfastClient', () => {
  it('sends auth headers to the packzy base URL and normalises the phone', async () => {
    const { sf, call } = client({ body: { status: 200, message: 'ok', consignment } });
    const result = await sf.createOrder(order);
    expect(result.consignment_id).toBe(1424107);
    const { url, init, json } = call();
    expect(url).toBe('https://portal.packzy.com/api/v1/create_order');
    expect(init.headers).toMatchObject({ 'Api-Key': 'k', 'Secret-Key': 's', 'Content-Type': 'application/json' });
    expect(json.recipient_phone).toBe('01712345678');
  });

  it('rejects bad input before calling the API', async () => {
    const { sf, fetchMock } = client();
    await expect(sf.createOrder({ ...order, recipient_phone: '12345' })).rejects.toMatchObject({ kind: 'validation' });
    await expect(sf.createOrder({ ...order, cod_amount: 99.5 })).rejects.toMatchObject({ kind: 'validation' });
    await expect(sf.createOrder({ ...order, invoice: ' ' })).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('books bulk orders on the extended endpoint and normalises each row', async () => {
    const { sf, call } = client({
      body: {
        status: 200,
        message: 'Processed bulk order entries.',
        data: [
          { invoice: 'INV-1', status: 'success', consignment_id: 1424107, tracking_code: '15BAEB8A', tracking_link: 'https://steadfast.com.bd/t/x' },
          { invoice: 'INV-2', status: 'error', error: ['The recipient phone format is invalid.'], consignment_id: null, tracking_code: null },
          { invoice: 'INV-3', status: null, error: '["THIS_INVOICE_ALREADY_EXISTS"]', consignment_id: null },
        ],
      },
    });
    const rows = await sf.createBulkOrders([order, { ...order, invoice: 'INV-2' }, { ...order, invoice: 'INV-3' }]);
    expect(call().url).toMatch(/\/create_order\/bulk-order\/extended$/);
    expect(call().json.data).toHaveLength(3);
    expect(rows).toEqual([
      { ok: true, invoice: 'INV-1', consignment_id: 1424107, tracking_code: '15BAEB8A', tracking_link: 'https://steadfast.com.bd/t/x' },
      { ok: false, invoice: 'INV-2', errors: ['The recipient phone format is invalid.'] },
      { ok: false, invoice: 'INV-3', errors: ['THIS_INVOICE_ALREADY_EXISTS'] },
    ]);
  });

  it('retries a bulk call once with JSON-encoded data if Steadfast answers 400 to the array form', async () => {
    const { sf, call, fetchMock } = client(
      { status: 400, body: { message: 'The data field is required.' } },
      { body: { status: 200, data: [{ invoice: 'INV-1', status: 'success', consignment_id: 1, tracking_code: 'T' }] } },
    );
    await expect(sf.createBulkOrders([order])).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.isArray(call(0).json.data)).toBe(true);
    expect(typeof call(1).json.data).toBe('string');
  });

  it('does not retry a bulk call on 422, 401 or 5xx', async () => {
    for (const status of [422, 401, 503]) {
      const { sf, fetchMock } = client({ status, body: { message: 'no' } });
      await expect(sf.createBulkOrders([order])).rejects.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects duplicate invoices and more than 500 orders before sending', async () => {
    const { sf, fetchMock } = client();
    await expect(sf.createBulkOrders([order, order])).rejects.toThrow(/duplicate invoice/);
    await expect(sf.createBulkOrders(Array.from({ length: 501 }, (_, i) => ({ ...order, invoice: `I${i}` })))).rejects.toThrow(/at most 500/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('books the valid orders and returns the invalid ones as failed rows, aligned by invoice', async () => {
    const { sf, call, fetchMock } = client({
      body: {
        status: 200,
        data: [
          { invoice: 'INV-3', status: 'success', consignment_id: 3, tracking_code: 'T3' },
          { invoice: 'INV-1', status: 'success', consignment_id: 1, tracking_code: 'T1' },
        ],
      },
    });
    const rows = await sf.createBulkOrders([
      order,
      { ...order, invoice: 'INV-2', recipient_phone: '12345' },
      { ...order, invoice: 'INV-3' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call().json.data.map((o: { invoice: string }) => o.invoice)).toEqual(['INV-1', 'INV-3']);
    expect(rows.map((r) => [r.invoice, r.ok])).toEqual([['INV-1', true], ['INV-2', false], ['INV-3', true]]);
    expect(rows[1]).toEqual({ ok: false, invoice: 'INV-2', errors: ['recipient_phone is not a valid BD mobile number'] });
  });

  it('does not call the API when every bulk order is invalid', async () => {
    const { sf, fetchMock } = client();
    const rows = await sf.createBulkOrders([
      { ...order, recipient_phone: '12345' },
      { ...order, invoice: 'INV-2', cod_amount: 1.5 },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.map((r) => [r.invoice, r.ok])).toEqual([['INV-1', false], ['INV-2', false]]);
  });

  it('keeps customer data out of validation messages', async () => {
    const { sf } = client();
    const secrets = ['01999', '99999999', 'SECRET/INV', 'Secret Name'];
    const msgs: string[] = [];
    const grab = async (p: Promise<unknown>) => {
      await p.then(
        () => expect.unreachable(),
        (e: Error) => msgs.push(e.message),
      );
    };
    await grab(sf.createOrder({ ...order, recipient_phone: '01999' }));
    await grab(sf.createOrder({ ...order, alternative_phone: '99999999' }));
    await grab(sf.createOrder({ ...order, invoice: 'SECRET/INV' }));
    await grab(sf.createOrder({ ...order, recipient_name: 'Secret Name'.padEnd(500, 'x') }));
    await grab(sf.createPickupRequest({ address_id: 1, police_station_id: 1, address: 'a', contact_number: '01999' }));
    await grab(sf.getFraudScore('01999'));
    await grab(sf.getPayment('SECRET'));
    expect(msgs).toHaveLength(7);
    for (const m of msgs) for (const secret of secrets) expect(m).not.toContain(secret);
    expect(msgs[0]).toBe('recipient_phone is not a valid BD mobile number');
  });

  it('enforces the limits Steadfast would silently truncate to', async () => {
    const { sf, fetchMock } = client();
    await expect(sf.createOrder({ ...order, invoice: 'ORD/1' })).rejects.toThrow(/letters, digits/);
    await expect(sf.createOrder({ ...order, invoice: 'x'.repeat(101) })).rejects.toThrow(/100 characters/);
    await expect(sf.createOrder({ ...order, recipient_address: 'a'.repeat(491) })).rejects.toThrow(/truncate/);
    await expect(sf.createOrder({ ...order, note: 'n'.repeat(481) })).rejects.toThrow(/truncate/);
    await expect(sf.createOrder({ ...order, cod_amount: 1_000_001 })).rejects.toThrow(/cod_amount/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('looks up status by consignment, invoice and tracking code', async () => {
    const ok = { body: { status: 200, delivery_status: 'delivered_approval_pending' } };
    const { sf, call } = client(ok, ok, ok);
    expect(await sf.getStatusByConsignmentId(1424107)).toBe('delivered_approval_pending');
    await sf.getStatusByInvoice('INV 1');
    await sf.getStatusByTrackingCode('15BAEB8A');
    expect(call(0).url).toMatch(/\/status_by_cid\/1424107$/);
    expect(call(1).url).toMatch(/\/status_by_invoice\/INV%201$/);
    expect(call(2).url).toMatch(/\/status_by_trackingcode\/15BAEB8A$/);
  });

  it('treats an unknown delivery_status as unexpected rather than guessing', async () => {
    const { sf } = client({ body: { status: 200, delivery_status: 'teleported' } });
    await expect(sf.getStatusByConsignmentId(1)).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('maps HTTP errors and HTTP-200-with-error-body to error kinds', async () => {
    const { sf } = client(
      { status: 401, body: { message: 'Unauthenticated.' } },
      { body: { status: 400, message: 'Invalid', errors: { recipient_phone: ['The recipient phone format is invalid.'] } } },
      { status: 422, body: { message: 'Invalid', errors: { invoice: ['THIS_INVOICE_ALREADY_EXISTS'] } } },
      { status: 403, body: { message: 'Account inactive' } },
      { status: 503, body: 'Service Unavailable' },
    );
    await expect(sf.getBalance()).rejects.toMatchObject({ kind: 'auth', httpStatus: 401, retryable: false });
    await expect(sf.createOrder(order)).rejects.toMatchObject({
      kind: 'validation',
      message: 'Invalid: The recipient phone format is invalid.',
    });
    await expect(sf.createOrder(order)).rejects.toMatchObject({ kind: 'duplicate' });
    await expect(sf.getBalance()).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(sf.getBalance()).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
  });

  it('treats 409 PICKUP_REQUEST_EXISTS as a duplicate', async () => {
    const { sf } = client({ status: 409, body: { message: 'PICKUP_REQUEST_EXISTS' } });
    await expect(
      sf.createPickupRequest({ address_id: 42, police_station_id: 17, address: 'Dhanmondi', contact_number: '01712345678' }),
    ).rejects.toMatchObject({ kind: 'duplicate' });
  });

  it('pings without sending keys', async () => {
    const { sf, call } = client({ body: 'pong' });
    await sf.ping();
    expect(call().url).toMatch(/\/ping$/);
    expect(call().init.headers).not.toHaveProperty('Api-Key');
  });

  it('reads return statuses, tracking history and pickup requests', async () => {
    const { sf, call } = client(
      { body: { status: 200, delivery_status: 'cancelled_return_received' } },
      {
        body: {
          status: 200,
          tracking: [{ consignment_id: 1, tracking_type: 1, text: 'Consignment created by Sender(API).', created_at: 'x' }],
        },
      },
      { status: 201, body: { message: 'Pickup request created successfully.', data: { id: 9081, req_status: 0 } } },
    );
    expect(await sf.getStatusWithReturnByConsignmentId(1)).toBe('cancelled_return_received');
    expect(call(0).url).toMatch(/\/status_with_return_status_by_cid\/1$/);
    expect(await sf.getTrackingByInvoice('INV-1')).toHaveLength(1);
    const pickup = await sf.createPickupRequest({
      address_id: 42,
      police_station_id: 17,
      address: 'House 17/1, Dhanmondi',
      contact_number: '+8801712345678',
      estim_qty: 25,
    });
    expect(pickup.id).toBe(9081);
    expect(call(2).json.contact_number).toBe('01712345678');
  });

  it('pages payments and return requests, and strips non-digits from payment ids', async () => {
    const { sf, call } = client(
      { body: { status: 1, alertClass: 'success', message: 'Fetched successfully!', payments: [{ payment_id: 'SFC-88213', amount: 12450 }] } },
      { body: { data: [{ id: 1, status: 'pending' }] } },
      { body: { payment_id: 'SFC-88213', consignments: [] } },
    );
    const payments = await sf.getPayments(2);
    expect(payments).toMatchObject({ page: 2, items: [{ payment_id: 'SFC-88213' }] });
    expect(call(0).url).toMatch(/\/payments\?page=2$/);
    await expect(sf.getReturnRequests()).resolves.toMatchObject({ page: 1, items: [{ id: 1 }] });
    expect(call(1).url).toMatch(/\/get_return_requests$/);
    await sf.getPayment('SFC-88213');
    expect(call(2).url).toMatch(/\/payments\/88213$/);
  });

  it('returns the fraud score without the envelope status, keeping nulls', async () => {
    const { sf, call } = client({
      body: {
        status: 200,
        phone: '01712345678',
        delivery_ratio: null,
        cancellation_ratio: null,
        volume_band: 'none',
        total_reports: 0,
        fraud_categories: [],
        score: null,
        level: null,
        reasons: [],
        scoring_disabled: true,
        doubtful_reports: false,
      },
    });
    const score = await sf.getFraudScore('+880 1712-345678');
    expect(call().url).toMatch(/\/fraud_check\/score\/01712345678$/);
    expect(score).not.toHaveProperty('status');
    expect(score.delivery_ratio).toBeNull();
  });

  it('never follows redirects, so keys cannot leak to another host', async () => {
    const { sf, call } = client({ body: { status: 200, current_balance: 1 } });
    await sf.getBalance();
    expect(call().init.redirect).toBe('error');
  });

  it('treats a non-JSON 2xx (proxy/CDN page) as retryable, not final', async () => {
    const { sf } = client({ body: '<html>cloudflare</html>' });
    await expect(sf.createOrder(order)).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
  });

  it('accepts a bare-array bulk response (older endpoint shape)', async () => {
    const { sf } = client({ body: [{ invoice: 'INV-1', status: 'success', consignment_id: 1, tracking_code: 'T' }] });
    await expect(sf.createBulkOrders([order])).resolves.toMatchObject([{ ok: true, consignment_id: 1 }]);
  });

  it('reads the balance', async () => {
    const { sf } = client({ body: { status: 200, current_balance: '1520.50' } });
    expect(await sf.getBalance()).toBe(1520.5);
  });

  it('requires exactly one return-request target', async () => {
    const { sf, call } = client({ status: 201, body: { id: 7, consignment_id: 1, status: 'pending' } });
    await expect(sf.createReturnRequest({ invoice: 'INV-1' }, 'damaged')).resolves.toMatchObject({ id: 7 });
    expect(call().json).toEqual({ invoice: 'INV-1', reason: 'damaged' });
    await expect(
      sf.createReturnRequest({ invoice: 'a', consignment_id: 1 } as never),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('times out and reports unavailable', async () => {
    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const sf = new SteadfastClient({ apiKey: 'k', secretKey: 's', timeoutMs: 10, fetch: hang as unknown as typeof fetch });
    await expect(sf.getBalance()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('normalizeBdPhone', () => {
  it.each([
    ['01712345678', '01712345678'],
    ['+8801712345678', '01712345678'],
    ['8801712345678', '01712345678'],
    ['017-1234 5678', '01712345678'],
  ])('%s → %s', (input, out) => expect(normalizeBdPhone(input)).toBe(out));

  it.each(['0171234567', '01212345678', '+14155550100', ''])('rejects %s', (input) =>
    expect(normalizeBdPhone(input)).toBeNull(),
  );
});
