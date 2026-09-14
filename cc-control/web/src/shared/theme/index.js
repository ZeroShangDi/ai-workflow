export const THEMES = Object.freeze({ dark: '深色', light: '浅色' });
export function resolveTheme(value) { return Object.hasOwn(THEMES, value) ? value : 'dark'; }
export function readTheme() {
  const value = new URLSearchParams(window.location.search).get('theme');
  if (value) return resolveTheme(value);
  try { return resolveTheme(window.localStorage.getItem('cc-work.theme')); }
  catch { return 'dark'; }
}
export function applyTheme(theme) {
  const selected = resolveTheme(theme);
  document.documentElement.dataset.theme = selected;
  try { window.localStorage.setItem('cc-work.theme', selected); } catch { /* private browsing */ }
  return selected;
}
