import { useEffect, useState, useCallback, type ReactNode } from 'react';
import axios from 'axios';
import { resolveTheme, applyTheme, clearThemeVars, PREDEFINED_THEMES, type ThemeVars } from '../themes';
import { useAuth } from './auth-context';
import { ThemeContext } from './theme-context';
import { API_BASE_URL } from '../config';

const DEFAULT_THEME_KEY = 'niki-light';

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useAuth();
  const [themeKey, setThemeKey] = useState<string>(DEFAULT_THEME_KEY);
  const [themeVars, setThemeVars] = useState<ThemeVars | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      clearThemeVars();
      setThemeKey(DEFAULT_THEME_KEY);
      setThemeVars(null);
      return;
    }

    const fetchPreferences = async () => {
      setLoading(true);
      try {
        const response = await axios.get<{ theme: string }>(`${API_BASE_URL}/settings/user-preferences`);
        const stored = response.data.theme ?? DEFAULT_THEME_KEY;
        const vars = resolveTheme(stored);
        setThemeKey(stored);
        setThemeVars(vars);
        if (vars) applyTheme(stored, vars);
      } catch {
        const fallback = resolveTheme(DEFAULT_THEME_KEY)!;
        setThemeVars(fallback);
        applyTheme(DEFAULT_THEME_KEY, fallback);
      } finally {
        setLoading(false);
      }
    };

    fetchPreferences();
  }, [isAuthenticated]);

  const setTheme = useCallback(async (value: string) => {
    const vars = resolveTheme(value);
    if (vars) {
      setThemeKey(value);
      setThemeVars(vars);
      applyTheme(value, vars);
    }

    await axios.put(`${API_BASE_URL}/settings/user-preferences`, { theme: value });
  }, []);

  const isPreset = PREDEFINED_THEMES.some((t) => t.key === themeKey);

  return (
    <ThemeContext.Provider value={{ themeKey, themeVars, loading, setTheme, isPreset }}>
      {children}
    </ThemeContext.Provider>
  );
};
