export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'zc_theme_preference';

export function getSavedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
  } catch {
    // Ignore storage errors
  }
  return 'light';
}

export function resolveEffectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function applyThemePreference(pref: ThemePreference, persist = true): 'light' | 'dark' {
  const effective = resolveEffectiveTheme(pref);

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (effective === 'dark') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }
  }

  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      // Ignore storage errors
    }
  }

  return effective;
}

export function initializeTheme(): 'light' | 'dark' {
  return applyThemePreference(getSavedThemePreference(), false);
}

export function subscribeSystemThemeChanges(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = () => onChange();
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }
  mq.addListener(listener);
  return () => mq.removeListener(listener);
}
