/**
 * Per-tab storage (sessionStorage). Each browser tab has its own SynthIQ draft/workspace data.
 * One-time migration: if sessionStorage is empty and localStorage still has the key, move it into this tab.
 */

export function tabStorageGetRaw(key) {
  try {
    let raw = sessionStorage.getItem(key);
    if (raw == null && typeof localStorage !== "undefined") {
      raw = localStorage.getItem(key);
      if (raw != null) {
        sessionStorage.setItem(key, raw);
        localStorage.removeItem(key);
      }
    }
    return raw;
  } catch {
    return null;
  }
}

export function tabStorageSetRaw(key, value) {
  sessionStorage.setItem(key, value);
}

export function tabStorageGetJson(key, fallback) {
  const raw = tabStorageGetRaw(key);
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function tabStorageSetJson(key, value) {
  tabStorageSetRaw(key, JSON.stringify(value));
}
