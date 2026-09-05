import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Input } from '../components/ui';
import { useAuth } from '../store/auth';

const DEMO = [
  ['owner', 'owner123', 'Owner'],
  ['manager', 'manager123', 'Manager'],
  ['cashier', 'cashier123', 'Cashier'],
  ['captain', 'captain123', 'Captain'],
];

export default function Login() {
  const [username, setU] = useState('cashier');
  const [password, setP] = useState('cashier123');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setSession = useAuth((s) => s.setSession);
  const deviceId = useAuth((s) => s.deviceId);

  const submit = async (u = username, p = password) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/auth/login', { username: u, password: p, deviceId });
      setSession(r.token, r.user);
    } catch (e: any) {
      setErr(e.message === 'offline' ? 'Cannot reach the server. Connect once to log in on this device.' : e.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-950 p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="text-2xl font-bold">
          <span className="text-brand-500">RMS</span> POS
        </div>
        <p className="text-sm text-slate-400">Sign in to this terminal</p>
        <Input placeholder="Username" value={username} onChange={(e) => setU(e.target.value)} autoFocus />
        <Input placeholder="Password" type="password" value={password} onChange={(e) => setP(e.target.value)} />
        {err && <div className="rounded bg-red-900/50 px-3 py-2 text-sm text-red-200">{err}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <div className="border-t border-slate-800 pt-3">
          <div className="mb-2 text-xs text-slate-500">Demo accounts</div>
          <div className="grid grid-cols-2 gap-2">
            {DEMO.map(([u, p, label]) => (
              <Button key={u} type="button" size="sm" variant="outline" onClick={() => submit(u, p)}>
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="text-center text-[11px] text-slate-600">Device {deviceId}</div>
      </form>
    </div>
  );
}
