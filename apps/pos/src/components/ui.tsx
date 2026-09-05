import { X } from 'lucide-react';
import { type ButtonHTMLAttributes, type ComponentProps, type ReactNode, useEffect } from 'react';
import { cn } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-slate-950 hover:bg-brand-400 font-semibold',
  secondary: 'bg-slate-800 text-slate-100 hover:bg-slate-700',
  ghost: 'bg-transparent text-slate-300 hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 font-semibold',
  outline: 'border border-slate-600 text-slate-200 hover:bg-slate-800',
};
const sizes = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base', xl: 'h-14 px-6 text-lg' };

export function Button({ variant = 'secondary', size = 'md', className, kbd, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof sizes; kbd?: string }) {
  return (
    <button
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap', variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
      {kbd && <span className="ml-1 rounded border border-current/30 px-1 text-[10px] opacity-70">{kbd}</span>}
    </button>
  );
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cn('h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-brand-500 focus:outline-none', className)}
      {...rest}
    />
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 no-print" onMouseDown={onClose}>
      <div className={cn('flex max-h-[92vh] w-full flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        {title && (
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'slate', className }: { children: ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'purple'; className?: string }) {
  const tones = {
    slate: 'bg-slate-800 text-slate-300',
    green: 'bg-emerald-900/60 text-emerald-300',
    red: 'bg-red-900/60 text-red-300',
    amber: 'bg-amber-900/60 text-amber-300',
    blue: 'bg-sky-900/60 text-sky-300',
    purple: 'bg-purple-900/60 text-purple-300',
  };
  return <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-transparent', className)} />;
}

/** Numeric keypad for amounts (rupees) — writes into a controlled string. */
export function NumPad({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'];
  const press = (k: string) => {
    if (k === '⌫') return onChange(value.slice(0, -1));
    if (k === '.' && value.includes('.')) return;
    onChange(value + k);
  };
  return (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((k) => (
        <button key={k} onClick={() => press(k)} className="h-12 rounded-lg bg-slate-800 text-lg font-semibold hover:bg-slate-700 active:bg-slate-600">
          {k}
        </button>
      ))}
      {onEnter && (
        <button onClick={onEnter} className="col-span-3 h-12 rounded-lg bg-brand-500 font-semibold text-slate-950 hover:bg-brand-400">
          Enter
        </button>
      )}
    </div>
  );
}

export function Toast({ toasts, dismiss }: { toasts: { id: number; text: string; tone?: 'ok' | 'err' | 'info' }[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2 no-print">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cn('pointer-events-auto rounded-lg px-4 py-2 text-sm shadow-lg', t.tone === 'err' ? 'bg-red-700 text-white' : t.tone === 'ok' ? 'bg-emerald-700 text-white' : 'bg-slate-700 text-slate-100')}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
