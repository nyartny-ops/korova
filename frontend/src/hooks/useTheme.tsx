import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

const STORAGE_DARK = 'korova-dark-mode';
const STORAGE_ULTRA = 'isUltraDarkThemeEnabled';

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

function applyDom(isDark: boolean, isUltra: boolean) {
  document.body.classList.remove('dark', 'light');
  document.body.classList.add(isDark ? 'dark' : 'light');
  // Native scrollbars read color-scheme, not the body class.
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  if (isUltra) {
    document.documentElement.setAttribute('data-theme', 'ultra-dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const msg = document.getElementById('message');
  if (msg) {
    msg.classList.remove('dark', 'light');
    msg.classList.add(isDark ? 'dark' : 'light');
  }
}

// module load so the document is in the right theme before React mounts.
const initialDark = readBool(STORAGE_DARK, false);
const initialUltra = readBool(STORAGE_ULTRA, false);
applyDom(initialDark, initialUltra);

const KOROVA_FONT = "'Onest Variable', 'Onest', system-ui, -apple-system, 'Segoe UI', sans-serif";

// Holstein: black ink on white; pink stays in charts and highlights, never on controls.
const LIGHT_TOKENS = {
  fontFamily: KOROVA_FONT,
  fontSize: 14,
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  controlHeight: 36,
  controlHeightSM: 30,
  colorPrimary: '#14161B',
  colorInfo: '#2F5BD3',
  colorLink: '#14161B',
  colorSuccess: '#1E8E4E',
  colorWarning: '#A86300',
  colorError: '#C8323A',
  colorText: '#14161B',
  colorTextSecondary: '#4B5160',
  colorTextTertiary: '#6B7180',
  colorTextDescription: '#6B7180',
  colorTextPlaceholder: '#8A909C',
  colorBorder: '#D3D6DD',
  colorBorderSecondary: '#E4E6EB',
  colorBgLayout: '#F4F5F7',
  colorBgContainer: '#FFFFFF',
  colorFillTertiary: '#F0F1F4',
  colorFillQuaternary: '#F7F8FA',
  boxShadowSecondary: '0 8px 28px rgba(20, 22, 27, 0.12)',
  wireframe: false,
};
const DARK_TOKENS = {
  ...LIGHT_TOKENS,
  colorPrimary: '#F1F3F6',
  colorLink: '#F1F3F6',
  colorSuccess: '#5FCF8E',
  colorWarning: '#E8B85A',
  colorError: '#F07A80',
  colorText: '#F1F3F6',
  colorTextSecondary: '#B9BFCB',
  colorTextTertiary: '#8E95A3',
  colorTextDescription: '#8E95A3',
  colorTextPlaceholder: '#6F7684',
  colorBorder: '#3A3F4A',
  colorBorderSecondary: '#2C3039',
  colorBgBase: '#15171C',
  colorBgLayout: '#15171C',
  colorBgContainer: '#1C1F26',
  colorBgElevated: '#23262E',
  colorFillTertiary: '#23262E',
  colorFillQuaternary: '#1F2229',
};
const ULTRA_DARK_TOKENS = {
  ...DARK_TOKENS,
  colorBgBase: '#000',
  colorBgLayout: '#000',
  colorBgContainer: '#0E0F12',
  colorBgElevated: '#17181C',
};
const lightComponents = {
  Layout: { bodyBg: '#F4F5F7', siderBg: '#FFFFFF', headerBg: '#FFFFFF', triggerBg: '#F0F1F4', triggerColor: '#14161B' },
  Menu: {
    itemBg: '#FFFFFF',
    itemColor: '#4B5160',
    itemHoverBg: '#F0F1F4',
    itemHoverColor: '#14161B',
    itemSelectedBg: '#14161B',
    itemSelectedColor: '#FFFFFF',
    itemBorderRadius: 8,
    itemHeight: 36,
    itemMarginInline: 10,
    subMenuItemBg: '#FFFFFF',
    activeBarBorderWidth: 0,
  },
  Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
  Table: { headerBg: '#FFFFFF', headerColor: '#6B7180', rowHoverBg: '#F7F8FA', cellPaddingBlock: 12 },
  Segmented: { trackBg: '#ECEDF1', itemSelectedBg: '#FFFFFF', itemColor: '#4B5160' },
  Drawer: { paddingLG: 24 },
  Statistic: { contentFontSize: 17, titleFontSize: 11 },
};
function darkComponents(ultra: boolean) {
  const side = ultra ? '#060608' : '#1A1C22';
  return {
    Layout: { bodyBg: ultra ? '#000' : '#15171C', siderBg: side, headerBg: side, triggerBg: '#23262E', triggerColor: '#F1F3F6' },
    Menu: {
      darkItemBg: side,
      darkSubMenuItemBg: side,
      darkPopupBg: '#23262E',
      darkItemSelectedBg: '#F1F3F6',
      darkItemSelectedColor: '#14161B',
      darkItemHoverBg: '#262932',
      itemBorderRadius: 8,
      itemHeight: 36,
      itemMarginInline: 10,
    },
    Button: { primaryColor: '#14161B', primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
    Table: { headerBg: 'transparent', rowHoverBg: '#21242B', cellPaddingBlock: 12 },
    Segmented: { trackBg: '#23262E', itemSelectedBg: '#2F333D' },
    Statistic: { contentFontSize: 17, titleFontSize: 11 },
  };
}

// hashed:false drops the `:where(.css-<hash>)` wrapper antd puts around every
// rule. It costs nothing in specificity — `:where()` contributes zero, so the
// panel's own `.ant-*` overrides still win — and it removes roughly 5,700
// wrappers, 16% of the generated stylesheet, from what the browser has to parse.
//
// cssVar.key pins the CSS-variable scope. Every panel page mounts its own
// ConfigProvider (there is no root one), and without a fixed key each mints a
// fresh useId-derived scope, so navigating re-serialises and re-injects the whole
// token block under a new class instead of reusing the one already in the head.
const SHARED_STYLE_CONFIG = {
  hashed: false,
  cssVar: { key: 'xui' },
} as const;

export function buildAntdThemeConfig(isDark: boolean, isUltra: boolean): ThemeConfig {
  if (!isDark) {
    return {
      ...SHARED_STYLE_CONFIG,
      algorithm: antdTheme.defaultAlgorithm,
      token: LIGHT_TOKENS,
      components: lightComponents,
    };
  }
  return {
    ...SHARED_STYLE_CONFIG,
    algorithm: antdTheme.darkAlgorithm,
    token: isUltra ? ULTRA_DARK_TOKENS : DARK_TOKENS,
    components: darkComponents(isUltra),
  };
}

export function pauseAnimationsUntilLeave(elementId: string): void {
  document.documentElement.setAttribute('data-theme-animations', 'off');
  const el = document.getElementById(elementId);
  if (!el) return;
  const restore = () => {
    document.documentElement.removeAttribute('data-theme-animations');
    el.removeEventListener('mouseleave', restore);
    el.removeEventListener('touchend', restore);
  };
  el.addEventListener('mouseleave', restore);
  el.addEventListener('touchend', restore);
}

interface ThemeContextValue {
  isDark: boolean;
  isUltra: boolean;
  toggleTheme: () => void;
  toggleUltra: () => void;
  antdThemeConfig: ThemeConfig;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState<boolean>(initialDark);
  const [isUltra, setIsUltra] = useState<boolean>(initialUltra);

  useLayoutEffect(() => {
    applyDom(isDark, isUltra);
    localStorage.setItem(STORAGE_DARK, String(isDark));
    localStorage.setItem(STORAGE_ULTRA, String(isUltra));
  }, [isDark, isUltra]);

  const toggleTheme = useCallback(() => setIsDark((v) => !v), []);
  const toggleUltra = useCallback(() => setIsUltra((v) => !v), []);

  const antdThemeConfig = useMemo(() => buildAntdThemeConfig(isDark, isUltra), [isDark, isUltra]);

  const value = useMemo<ThemeContextValue>(
    () => ({ isDark, isUltra, toggleTheme, toggleUltra, antdThemeConfig }),
    [isDark, isUltra, toggleTheme, toggleUltra, antdThemeConfig],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
