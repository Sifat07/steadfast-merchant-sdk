/**
 * Book a parcel safely, then read where it is.
 *
 *   STEADFAST_API_KEY=… STEADFAST_SECRET_KEY=… npx tsx examples/book-and-track.ts
 *
 * ⚠ Steadfast has no sandbox. On a live account this books a REAL parcel.
 */
import {
  SteadfastClient,
  SteadfastError,
  isApprovalPending,
  isFinalStatus,
  type Consignment,
  type CreateOrderRequest,
} from 'steadfast-merchant-sdk';

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY ?? '',
  secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
});

/**
 * Book once, even across retries. The invoice is the idempotency key:
 * Steadfast refuses a repeat, so retrying with the SAME invoice can't book
 * twice. Never generate a new invoice for a retry.
 */
async function bookOnce(order: CreateOrderRequest, attempts = 3): Promise<Consignment | 'already-booked'> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await steadfast.createOrder(order);
    } catch (e) {
      if (!(e instanceof SteadfastError)) throw e;
      // An earlier attempt landed (e.g. it timed out after Steadfast accepted it).
      if (e.kind === 'duplicate') return 'already-booked';
      // Never retry auth in a loop: 10 failures in 5 minutes locks you out for an hour.
      if (!e.retryable || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const order: CreateOrderRequest = {
  invoice: 'ORD-10231', // your order number: letters, digits, - and _ only, ≤ 100
  recipient_name: 'Jahid Hasan',
  recipient_phone: '+880 1712-345678', // normalised to 01712345678
  recipient_address: 'House 17/1, Road 3/A, Dhanmondi, Dhaka-1209',
  cod_amount: 1060, // whole taka; 0 for prepaid
  note: 'Call before 3 PM',
};

const booked = await bookOnce(order);
if (booked === 'already-booked') {
  console.log('Already booked earlier; status:', await steadfast.getStatusByInvoice(order.invoice));
} else {
  // Store both: consignment_id for API lookups, tracking_code for the customer.
  console.log('Booked', booked.consignment_id, booked.tracking_code, booked.status); // status starts at in_review

  const status = await steadfast.getStatusByConsignmentId(booked.consignment_id);
  if (isApprovalPending(status)) console.log('Rider reported an outcome; wait for Steadfast to confirm it.');
  else if (isFinalStatus(status)) console.log('Final:', status);
  else console.log('In progress:', status);

  // The full history, for a "where is my order?" page.
  for (const step of await steadfast.getTrackingByInvoice(order.invoice)) {
    console.log(step.created_at, step.text);
  }
}
