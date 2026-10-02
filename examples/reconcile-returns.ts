/**
 * Restock only when a returned parcel is physically back.
 *
 * `cancelled` means "not delivered, coming back to you" — the goods are still
 * with the courier, and can be lost on the way. Only the return-status lookup
 * says they've arrived. Run this on a schedule (not faster than every minute:
 * Steadfast caches status for 60 s) over parcels you've seen cancelled or
 * partially delivered.
 */
import { SteadfastClient, isReturnReceived } from 'steadfast-merchant-sdk';

const steadfast = new SteadfastClient({
  apiKey: process.env.STEADFAST_API_KEY ?? '',
  secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
});

/** Replace with your own store: parcels that are on their way back. */
const awaitingReturn: Array<{ consignmentId: number; invoice: string }> = [];

for (const parcel of awaitingReturn) {
  const status = await steadfast.getStatusWithReturnByConsignmentId(parcel.consignmentId);

  if (isReturnReceived(status)) {
    // cancelled_return_received → restock the whole order
    // partial_delivered_return_received → restock only the refused items
    console.log(`${parcel.invoice}: back with you (${status}) — restock now`);
  } else if (status === 'exceptional') {
    console.log(`${parcel.invoice}: lost or damaged — contact Steadfast support, don't restock`);
  } else {
    console.log(`${parcel.invoice}: still on its way back (${status})`);
  }
}
