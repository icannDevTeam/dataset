/**
 * lib/theme.js — Tailwind class-based dark/light theme toggle.
 *
 * Tailwind config has `darkMode: 'class'`. We toggle the 'dark' class
 * on <html> and persist the choice in localStorage('binus-theme').
 *
 * First-load rule: if the user has never picked a theme, we follow the
 * OS `prefers-color-scheme` setting. Once they toggle manually, the
 * choice is persisted and overrides system changes for that browser.
 */
import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'binus-theme';
const VALID = ['dark', 'light'];

function systemPreference() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch { return 'dark'; }
}

export function getStoredTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (VALID.includes(v)) return v;
    return systemPreference();
  } catch { return 'dark'; }
}

export function applyTheme(theme, { persist = true } = {}) {
  if (typeof document === 'undefined') return;
  const next = VALID.includes(theme) ? theme : 'dark';
  document.documentElement.classList.toggle('dark', next === 'dark');
  document.documentElement.dataset.theme = next;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState('dark');

  useEffect(() => {
    const t = getStoredTheme();
    setThemeState(t);
    // Don't re-persist on initial read — keeps the "no explicit choice yet"
    // state so future system changes are still followed.
    let hasExplicitChoice = false;
    try { hasExplicitChoice = VALID.includes(localStorage.getItem(STORAGE_KEY)); } catch {}
    applyTheme(t, { persist: hasExplicitChoice });

    // Follow system changes until the user makes an explicit choice.
    if (!hasExplicitChoice && typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: light)');
      const handler = (ev) => {
        let stillImplicit = true;
        try { stillImplicit = !VALID.includes(localStorage.getItem(STORAGE_KEY)); } catch {}
        if (!stillImplicit) return;
        const next = ev.matches ? 'light' : 'dark';
        applyTheme(next, { persist: false });
        setThemeState(next);
      };
      try { mql.addEventListener('change', handler); } catch { mql.addListener(handler); }
      return () => { try { mql.removeEventListener('change', handler); } catch { mql.removeListener(handler); } };
    }
    return undefined;
  }, []);

  const setTheme = useCallback((next) => {
    const t = VALID.includes(next) ? next : 'dark';
    applyTheme(t); // persists
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}

// Inline script (string) to inject into <Head> to prevent FOUC.
// Mirrors getStoredTheme() — stored value wins, else system preference.
export const FOUC_SCRIPT = `
(function(){try{var t=localStorage.getItem('binus-theme');if(t!=='dark'&&t!=='light'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.classList.add('dark');document.documentElement.dataset.theme='dark';}})();
`.trim();
