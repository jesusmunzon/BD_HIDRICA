export const UI_STATE_KEYS = Object.freeze({
  statistics1: 'estadisticos1-filter-state',
  statistics2: 'estadisticos2-filter-state',
  statistics3: 'estadisticos3-filter-state',
  statistics4: 'estadisticos4-filter-state',
});
export function readFilterState(key, fallback = {}) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback };
  } catch { return { ...fallback }; }
}
export function writeFilterState(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* continúa sin persistencia */ }
}
