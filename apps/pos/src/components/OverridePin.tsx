import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button, Modal, NumPad } from './ui';

/** Manager PIN prompt → stores a 5-minute override token used by the next sensitive actions. */
export function OverridePin({ open, onClose, onGranted, reason }: { open: boolean; onClose: () => void; onGranted: () => void; reason?: string }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setOverride = useAuth((s) => s.setOverride);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/auth/override', { pin });
      setOverride(r.overrideToken, r.by.name);
      setPin('');
      onGranted();
    } catch (e: any) {
      setErr(e.message === 'offline' ? 'Manager approval needs a connection' : 'Invalid PIN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Manager PIN required" width="max-w-xs">
      {reason && <p className="mb-3 text-sm text-slate-400">{reason}</p>}
      <div className="mb-3 h-12 rounded-lg bg-slate-950 text-center text-2xl leading-[3rem] tracking-[0.5em]">{'•'.repeat(pin.length) || <span className="text-slate-600">PIN</span>}</div>
      <NumPad value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))} onEnter={submit} />
      {err && <div className="mt-2 text-sm text-red-300">{err}</div>}
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
