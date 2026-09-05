import { useLiveQuery } from 'dexie-react-hooks';
import { Badge, Button } from '../components/ui';
import { db, meta } from '../lib/db';
import { bootstrap, discardRejected, flush, retryRejected, useSync } from '../lib/sync';
import { useAuth } from '../store/auth';

/** Offline queue inspector: what's waiting, what the server rejected, and manual controls. */
export default function SyncPage() {
  const { online, pending, rejected, syncing, lastSyncAt } = useSync();
  const deviceId = useAuth((s) => s.deviceId);
  const ops = useLiveQuery(() => db.ops.orderBy('seq').reverse().limit(100).toArray(), []) ?? [];
  const prints = useLiveQuery(() => db.printQueue.count(), []) ?? 0;
  const bootstrapAt = useLiveQuery(() => meta.get<string>('bootstrapAt'), []);
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Sync</h1>
        <Badge tone={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Badge>
        <span className="text-sm text-slate-400">Device {deviceId}</span>
        <span className="text-sm text-slate-400">Pending {pending} · Rejected {rejected} · Print jobs {prints}</span>
        <span className="text-xs text-slate-500">Last sync {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : '—'} · Menu cached {bootstrapAt ? new Date(bootstrapAt).toLocaleString() : '—'}</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => flush()} disabled={syncing}>
            Sync now
          </Button>
          <Button variant="outline" onClick={() => bootstrap()}>
            Refresh menu & floor
          </Button>
          {rejected > 0 && <Button variant="primary" onClick={() => retryRejected()}>Retry rejected</Button>}
        </div>
      </div>
      <p className="mb-3 text-sm text-slate-400">
        While offline, every order, KOT, bill and payment is stored here and replayed in order when the connection returns. Bills printed offline carry a provisional number (OFF-…); the server assigns the real invoice number on sync.
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-slate-400">
          <tr>
            <th className="px-2 py-1">Time</th>
            <th className="px-2 py-1">Op</th>
            <th className="px-2 py-1">Order</th>
            <th className="px-2 py-1">Status</th>
            <th className="px-2 py-1">Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op) => (
            <tr key={op.id} className="border-t border-slate-800/60">
              <td className="px-2 py-1 text-slate-400">{new Date(op.at).toLocaleTimeString()}</td>
              <td className="px-2 py-1">{op.type}</td>
              <td className="px-2 py-1 text-slate-400">{op.orderId?.slice(0, 8)}</td>
              <td className="px-2 py-1">
                <Badge tone={op.status === 'APPLIED' ? 'green' : op.status === 'REJECTED' ? 'red' : 'amber'}>{op.status}</Badge>
              </td>
              <td className="max-w-md truncate px-2 py-1 text-xs text-red-300">{op.error}</td>
              <td className="px-2 py-1 text-right">
                {op.status === 'REJECTED' && (
                  <>
                    <Button size="sm" onClick={() => retryRejected(op.id)}>Retry</Button>{' '}
                    <Button size="sm" variant="ghost" onClick={() => discardRejected(op.id)}>Discard</Button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {ops.length === 0 && (
            <tr>
              <td colSpan={6} className="p-4 text-center text-slate-500">Queue is empty</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
