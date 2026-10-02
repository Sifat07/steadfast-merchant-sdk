/**
 * Receive Steadfast webhooks with Fastify.
 *
 *   STEADFAST_WEBHOOK_TOKEN=… npx tsx examples/webhook-fastify.ts
 *
 * Then set the Callback URL (https) and the same Auth token in the merchant
 * panel's Webhook page.
 */
import Fastify from 'fastify';
import { handleSteadfastWebhook, isDeliveryStatusEvent, isTrackingUpdateEvent } from 'steadfast-merchant-sdk/webhooks';

const token = process.env.STEADFAST_WEBHOOK_TOKEN;
if (!token) throw new Error('Set STEADFAST_WEBHOOK_TOKEN to the auth token from the merchant panel');

const app = Fastify({ logger: true });
const seen = new Set<string>(); // use a database table with a unique key in production

await app.register(async (scope) => {
  // X-Signature is an HMAC of the exact bytes Steadfast sent, so this route
  // must see the raw body. Fastify's default JSON parser would hand us a
  // parsed object, and re-serialising it can change the bytes. Scoping the
  // parser to this plugin leaves the rest of the app's JSON handling alone.
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  scope.post('/webhooks/steadfast', async (req, reply) => {
    const result = handleSteadfastWebhook({ rawBody: req.body as Buffer, headers: req.headers, token });

    if (!result.ok) {
      // 4xx: Steadfast won't retry, which is right — a bad signature won't improve.
      req.log.warn({ reason: result.error.reason }, result.error.message);
      return reply.code(result.httpStatus).send(result.response);
    }

    // Retries repeat the Idempotency-Key. Record it before doing the work.
    const key = result.idempotencyKey;
    if (key && seen.has(key)) return reply.code(200).send(result.response);
    if (key) seen.add(key);

    const event = result.event;
    if (isDeliveryStatusEvent(event)) {
      // Signed by Steadfast, so the payload is trustworthy. Act on confirmed
      // outcomes only; *_approval_pending is the rider's word, not Steadfast's.
      req.log.info({ invoice: event.invoice, status: event.status, cod: event.cod_amount }, 'delivery status');
    } else if (isTrackingUpdateEvent(event)) {
      req.log.info({ invoice: event.invoice }, event.tracking_message);
    } else {
      req.log.info({ type: event.notification_type }, 'other Steadfast event');
    }

    // Answer within 5 s. Slow work belongs in a queue, after this reply.
    return reply.code(200).send(result.response);
  });
});

await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
