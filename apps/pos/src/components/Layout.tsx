import { useLiveQuery } from 'dexie-react-hooks';
import { BarChart3, CloudOff, LayoutGrid, ListOrdered, LogOut, RefreshCw, Settings, ShieldCheck, Utensils, Wifi } from 'lucide-react';
import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cache } from '../lib/db';
import { cn } from '../lib/format';
import { flush, useSync } from '../lib/sync';
import { useAuth } from '../store/auth';

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, can, overrideBy } = useAuth();
  const { online, pending, rejected, syncing } = useSync();
  const outlet = useLiveQuery(() => cache.outlet());
  const nav = [
    { to: '/', icon: LayoutGrid, label: 'Tables', show: true },
    { to: '/orders', icon: ListOrdered, label: 'Orders', show: true },
    { to: '/reports', icon: BarChart3, label: 'Today', show: can('reports.read') },
    { to: '/admin/menu', icon: Utensils, label: 'Menu', show: can('menu.write') },
    { to: '/admin/tables', icon: LayoutGrid, label: 'Floor', show: can('tables.write') },
    { to: '/admin/settings', icon: Settings, label: 'Settings', show: can('settings.write') },
  ];
  return (
    <div className="flex h-full flex-col">
      <header className="no-print flex h-12 shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900 px-3">
        <div className="mr-2 font-bold tracking-tight">
          <span className="text-brand-500">RMS</span> POS
        </div>
        <div className="hidden text-sm text-slate-400 md:block">{outlet?.name}</div>
        <nav className="ml-4 flex items-center gap-1">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) => cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm', isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white')}
              >
                <n.icon size={16} /> <span className="hidden lg:inline">{n.label}</span>
              </NavLink>
            ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {overrideBy && (
            <span className="flex items-center gap-1 rounded bg-purple-900/60 px-2 py-1 text-purple-200">
              <ShieldCheck size={14} /> Override: {overrideBy}
            </span>
          )}
          <NavLink
            to="/sync"
            className={cn('flex items-center gap-1.5 rounded-md px-2 py-1', online ? 'text-emerald-400' : 'bg-red-900/50 text-red-300')}
            title={online ? 'Online' : 'Offline — orders are queued locally'}
          >
            {online ? <Wifi size={14} /> : <CloudOff size={14} />}
            <span>{online ? 'Online' : 'Offline'}</span>
            {(pending > 0 || rejected > 0) && (
              <span className={cn('rounded-full px-1.5 text-[10px] font-bold', rejected ? 'bg-red-500 text-white' : 'bg-amber-500 text-slate-950')}>{pending + rejected}</span>
            )}
          </NavLink>
          <button onClick={() => flush()} className="rounded p-1 text-slate-400 hover:text-white" title="Sync now">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>
          <span className="hidden text-slate-400 sm:inline">
            {user?.name} · {user?.role}
          </span>
          <button onClick={logout} className="rounded p-1 text-slate-400 hover:text-white" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
