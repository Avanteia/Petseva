import { formatINR } from '@rms/shared';

export const inr = (p: number) => formatINR(p);
export const inrShort = (p: number) => (p % 100 === 0 ? '₹' + (p / 100).toLocaleString('en-IN') : formatINR(p));
export const timeAgo = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | 0).toString(16)));
export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export const FOOD_DOT: Record<string, string> = { VEG: 'bg-green-500', NON_VEG: 'bg-red-500', EGG: 'bg-yellow-400' };
