/**
 * lib/theme.js — Tailwind class-based dark/light theme toggle.
 *
 * Tailwind config has `darkMode: 'class'`. We toggle the 'dark' class
 * on <html> and persist the choice in localStorage('binus-theme').
 *
 * IMPORTANT: This is a shell-only PoC. Inner page content was authored
 * before darkMode existed (no `dark:` prefixes), so the toggle currently
 * only re-themes the V2Layout chrome (sidebar, topbar, body bg). Adding
 * full light-mode support to inner pages is a follow-up.
 */
import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'binus-theme';
const VALID = ['dark', 'light'];

export function getStoredTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : 'dark';
  } catch { return 'dark'; }
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const next = VALID.includes(theme) ? theme : 'dark';
  document.documentElement.classList.toggle('dark', next === 'dark');
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
}

export function useTheme() {
  const [theme, setThemeState] = useState('dark');

  useEffect(() => {
    const t = getStoredTheme();
    setThemeState(t);
    applyTheme(t);
  }, []);

  const setTheme = useCallback((next) => {
    const t = VALID.includes(next) ? next : 'dark';
    applyTheme(t);
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}

// Inline script (string) to inject into <Head> to prevent FOUC.
export const FOUC_SCRIPT = `
(function(){try{var t=localStorage.getItem('binus-theme');if(t!=='light')t='dark';document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.classList.add('dark');}})();
`.trim();
