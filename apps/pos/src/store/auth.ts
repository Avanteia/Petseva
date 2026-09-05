import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../lib/types';

interface AuthState {
  token: string | null;
  user: User | null;
  deviceId: string;
  overrideToken: string | null;
  overrideBy: string | null;
  setSession: (token: string, user: User) => void;
  setOverride: (token: string | null, by: string | null) => void;
  logout: () => void;
  can: (perm: string) => boolean;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      deviceId: 'D' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      overrideToken: null,
      overrideBy: null,
      setSession: (token, user) => set({ token, user }),
      setOverride: (overrideToken, overrideBy) => {
        set({ overrideToken, overrideBy });
        if (overrideToken) setTimeout(() => set({ overrideToken: null, overrideBy: null }), 4.5 * 60 * 1000);
      },
      logout: () => set({ token: null, user: null, overrideToken: null, overrideBy: null }),
      can: (perm) => !!get().user?.permissions.includes(perm) || !!get().overrideToken,
    }),
    { name: 'rms-auth', partialize: (s) => ({ token: s.token, user: s.user, deviceId: s.deviceId }) },
  ),
);
