import { AlertTriangle, RefreshCw, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn, inr } from '../../lib/format';

type Anomaly = { kind: string; date?: string; label: string; metric: string; value: number; baseline: number; zScore: number; explanation?: string };
type Summary = {
  sales: number;
  billCount: number;
  avgOrderValue: number;
  periodLabel: string;
  salesVsBaselinePct?: number | null;
  anomalies: Anomaly[];
  narrative: string;
};
type StaffRow = { userId: string; name: string; voidCount: number; orderCount: number; voidRatePct: number; outlier: boolean };

/** AI insights & anomaly detection — deterministic stats (see @rms/shared/stats) narrated by an
 *  AiProvider (mock by default, Claude when AI_PROVIDER=anthropic). No polling: a real AI call
 *  has latency/cost, so this refreshes on demand via the Regenerate button, like admin CRUD pages. */
export default function AdminInsights() {
  const [tab, setTab] = useState<'daily' | 'weekly'>('daily');
  const [date, setDate] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    setLoading(true);
    setErr('');
    const path = tab === 'daily' ? `/insights/daily${date ? `?date=${date}` : ''}` : '/insights/weekly';
    Promise.all([api<Summary>('GET', path), api<StaffRow[]>('GET', '/insights/staff-outliers')])
      .then(([s, st]) => {
        setSummary(s);
        setStaff(st);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [tab]);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles size={18} className="text-brand-500" /> AI Insights
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-800 text-sm">
            <button className={cn('px-3 py-1', tab === 'daily' ? 'bg-slate-800 text-white' : 'text-slate-400')} onClick={() => setTab('daily')}>
              Daily
            </button>
            <button className={cn('px-3 py-1', tab === 'weekly' ? 'bg-slate-800 text-white' : 'text-slate-400')} onClick={() => setTab('weekly')}>
              Weekly
            </button>
          </div>
          {tab === 'daily' && (
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-sm text-slate-200" />
          )}
          <button onClick={load} className="flex items-center gap-1.5 rounded-md border border-slate-800 px-2.5 py-1 text-sm text-slate-300 hover:text-white">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Regenerate
          </button>
        </div>
      </div>

      {err && !summary && <div className="p-6 text-slate-400">Insights need a connection. ({err})</div>}
      {!summary && !err && <div className="p-6 text-slate-400">Loading…</div>}

      {summary && (
        <>
          <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="mb-1 text-xs uppercase text-slate-400">{summary.periodLabel}</div>
            <p className="text-sm text-slate-200">{summary.narrative}</p>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Sales" value={inr(summary.sales)} />
            <Stat label="Bills" value={String(summary.billCount)} />
            <Stat label="Avg bill" value={inr(summary.avgOrderValue)} />
            <Stat
              label="Vs. weekday baseline"
              value={summary.salesVsBaselinePct == null ? '—' : `${summary.salesVsBaselinePct >= 0 ? '+' : ''}${summary.salesVsBaselinePct.toFixed(0)}%`}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900">
              <div className="flex items-center gap-1.5 border-b border-slate-800 px-4 py-2 text-sm font-semibold">
                <AlertTriangle size={14} className="text-amber-400" /> Anomalies
              </div>
              <div className="p-2 text-sm">
                {summary.anomalies.length === 0 && <div className="p-2 text-slate-500">Nothing unusual flagged.</div>}
                {summary.anomalies.map((a, i) => (
                  <div key={i} className="border-b border-slate-800/60 px-2 py-2 last:border-0">
                    <div className="flex items-center gap-1.5 font-medium text-slate-200">
                      {a.zScore < 0 ? <TrendingDown size={14} className="text-red-400" /> : <TrendingUp size={14} className="text-amber-400" />}
                      {a.label}
                    </div>
                    {a.explanation && <div className="mt-0.5 text-slate-400">{a.explanation}</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900">
              <div className="border-b border-slate-800 px-4 py-2 text-sm font-semibold">Staff void-rate (last 75 days)</div>
              <div className="p-2 text-sm">
                {!staff?.length && <div className="p-2 text-slate-500">—</div>}
                {staff?.map((s) => (
                  <div key={s.userId} className={cn('flex justify-between px-2 py-1', s.outlier && 'text-amber-300')}>
                    <span>
                      {s.name}
                      {s.outlier && ' ⚠'}
                    </span>
                    <span>
                      {s.voidRatePct.toFixed(1)}% ({s.voidCount}/{s.orderCount})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs uppercase text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
