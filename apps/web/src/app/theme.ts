import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Accent } from '@nexus/core';

type ThemeMode = 'dark' | 'light' | 'system';

interface ThemeState {
  mode: ThemeMode;
  accent: Accent;
  setMode: (m: ThemeMode) => void;
  setAccent: (a: Accent) => void;
}

function apply(mode: ThemeMode, accent: Accent): void {
  const el = document.documentElement;
  const dark =
    mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  el.classList.toggle('dark', dark);
  el.dataset.accent = accent === 'mono' ? 'mono' : 'emerald';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(el).getPropertyValue('--bg-canvas').trim());
}

export const useTheme = create<ThemeState>()(
  persist(
    () => ({
      mode: 'system' as ThemeMode,
      accent: 'emerald' as Accent,
      setMode: (mode: ThemeMode) => {
        useTheme.setState({ mode });
        apply(mode, useTheme.getState().accent);
      },
      setAccent: (accent: Accent) => {
        useTheme.setState({ accent: accent === 'mono' ? 'mono' : 'emerald' });
        apply(useTheme.getState().mode, accent);
      },
    }),
    {
      name: 'cortex-theme',
      version: 1,
      migrate: (saved) => {
        const state = saved as Partial<ThemeState>;
        return { ...state, accent: state.accent === 'mono' ? 'mono' : 'emerald' };
      },
      onRehydrateStorage: () => (state) => {
        if (state) apply(state.mode, state.accent);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          apply(useTheme.getState().mode, useTheme.getState().accent);
        });
      },
    },
  ),
);
