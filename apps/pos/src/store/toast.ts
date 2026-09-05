import { create } from 'zustand';

interface ToastState {
  toasts: { id: number; text: string; tone?: 'ok' | 'err' | 'info' }[];
  push: (text: string, tone?: 'ok' | 'err' | 'info') => void;
  dismiss: (id: number) => void;
}
let n = 0;
export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = ++n;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'err' ? 5000 : 2500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export const toast = (text: string, tone?: 'ok' | 'err' | 'info') => useToast.getState().push(text, tone);
