# Examples

| File | What it shows |
| --- | --- |
| [`book-and-track.ts`](book-and-track.ts) | Booking with safe retries (same invoice), status and tracking history |
| [`webhook-fastify.ts`](webhook-fastify.ts) | A signed-webhook endpoint in Fastify, with a raw-body parser scoped to the route |
| [`webhook-express.ts`](webhook-express.ts) | The same in Express, with `express.raw` |
| [`reconcile-returns.ts`](reconcile-returns.ts) | Restocking only when a return is physically back |

They import `steadfast-merchant-sdk` as an installed package would. In this repo, `tsconfig.json` maps that name to `src/`, so `pnpm type-check` checks them. Run one with `npx tsx examples/<file>.ts`.

**Steadfast has no sandbox.** `book-and-track.ts` books a real parcel on a live account.
