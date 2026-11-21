import { createContext, useContext } from 'react';
import type { ThemeVars } from '../themes';

export interface ThemeContextType {
  themeKey: string;
  themeVars: ThemeVars | null;
  loading: boolean;
  setTheme: (themeKeyOrJson: string) => Promise<void>;
  isPreset: boolean;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
};
