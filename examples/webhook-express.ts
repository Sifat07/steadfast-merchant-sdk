/**
 * Receive Steadfast webhooks with Express.
 *
 *   STEADFAST_WEBHOOK_TOKEN=… npx tsx examples/webhook-express.ts
 */
import express from 'express';
import { handleSteadfastWebhook, isDeliveryStatusEvent } from 'steadfast-merchant-sdk/webhooks';

const token = process.env.STEADFAST_WEBHOOK_TOKEN;
if (!token) throw new Error('Set STEADFAST_WEBHOOK_TOKEN to the auth token from the merchant panel');

const app = express();

// express.raw MUST run for this route instead of express.json: the signature
// covers the exact bytes. If you use app.use(express.json()) globally, mount
// this route BEFORE it, or the body arrives already parsed.
app.post('/webhooks/steadfast', express.raw({ type: 'application/json' }), (req, res) => {
  const result = handleSteadfastWebhook({ rawBody: req.body as Buffer, headers: req.headers, token });

  if (result.ok && isDeliveryStatusEvent(result.event)) {
    console.log(result.idempotencyKey, result.event.invoice, result.event.status);
  }
  res.status(result.httpStatus).json(result.response);
});

app.use(express.json()); // the rest of your app

app.listen(Number(process.env.PORT ?? 3000));
