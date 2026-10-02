// Read-only check against a live Steadfast account. Never creates orders or
// return requests — on a live account those book real pickups.
//
//   cp .env.example .env   # fill in STEADFAST_API_KEY / STEADFAST_SECRET_KEY
//   pnpm build && pnpm smoke
//
// Prints each raw response body so the SDK's response types can be checked
// against what Steadfast really sends. Credentials are never printed.
import { SteadfastClient } from '../dist/index.mjs';

const loggingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`\n${init.method} ${new URL(url).pathname} → HTTP ${res.status}\n${text.slice(0, 2000)}`);
  return res;
};

const sf = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY ?? '',
  secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
  ...(process.env.STEADFAST_BASE_URL ? { baseUrl: process.env.STEADFAST_BASE_URL } : {}),
  fetch: loggingFetch,
});

const checks = [
  ['ping', () => sf.ping()],
  ['getBalance', () => sf.getBalance()],
  ['getReturnRequests', () => sf.getReturnRequests()],
  ['getPayments', () => sf.getPayments()],
  ['getPoliceStations', () => sf.getPoliceStations().then((list) => `${list.length} stations, first: ${JSON.stringify(list[0])}`)],
];
const cid = process.env.STEADFAST_SMOKE_CONSIGNMENT_ID;
const invoice = process.env.STEADFAST_SMOKE_INVOICE;
if (cid) {
  checks.push(['getStatusByConsignmentId', () => sf.getStatusByConsignmentId(cid)]);
  checks.push(['getStatusWithReturnByConsignmentId', () => sf.getStatusWithReturnByConsignmentId(cid)]);
}
if (invoice) checks.push(['getTrackingByInvoice', () => sf.getTrackingByInvoice(invoice)]);
if (!cid || !invoice) {
  console.log('(set STEADFAST_SMOKE_CONSIGNMENT_ID and STEADFAST_SMOKE_INVOICE of an existing parcel to check lookups too)');
}

let failed = 0;
for (const [name, run] of checks) {
  try {
    console.log(`✓ ${name}:`, JSON.stringify(await run()).slice(0, 200));
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: [${e.kind}] ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
