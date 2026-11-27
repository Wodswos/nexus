/** Numeric geometry needed by canvas measurement. Keep aligned with tokens.css. */
export const UI_GEOMETRY = {
  nodeTitleSize: 14,
  nodeTitleWeight: 600,
  nodeTitleLeading: 20,
  rootInsetX: 16,
  rootInsetY: 12,
  nodeInsetX: 14,
  nodeInsetY: 10,
  gridGap: 20,
  gridDotSize: 1,
  edgeWidth: 1.5,
  edgeActiveWidth: 2,
} as const;

/** Non-CSS APIs (xterm, native color inputs) need resolved semantic colors. */
export function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function terminalTheme() {
  return {
    background: tokenValue('--terminal-bg'),
    foreground: tokenValue('--terminal-text'),
    cursor: tokenValue('--terminal-cursor'),
    selectionBackground: tokenValue('--terminal-selection'),
  };
}
