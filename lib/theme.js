import { useCallback } from 'react';

export function applyTheme() {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.add('dark');
  document.documentElement.dataset.theme = 'dark';
  try { localStorage.removeItem('binus-theme'); } catch {}
}

export function useTheme() {
  return {
    theme: 'dark',
    setTheme: () => {},
    toggle: useCallback(() => {}, []),
  };
}
