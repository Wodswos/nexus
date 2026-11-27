import { type MindColor, type MindFont, type Task } from '@nexus/core';
import type { CSSProperties } from 'react';
import { UI_GEOMETRY } from '@nexus/ui';

export const DEFAULT_MIND_FONT: MindFont = 'sans';

export const FONT_FAMILIES = {
  sans: '"Inter Variable", Inter, -apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", sans-serif',
  serif: 'ui-serif, Georgia, "Noto Serif CJK SC", serif',
  mono: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  'noto-sans-sc': '"Noto Sans SC Variable", system-ui, sans-serif',
  'noto-serif-sc': '"Noto Serif SC Variable", ui-serif, serif',
  'lxgw-wenkai': '"LXGW WenKai", ui-serif, serif',
  inter: '"Inter Variable", system-ui, sans-serif',
  'jetbrains-mono': '"JetBrains Mono Variable", ui-monospace, monospace',
};
export const FONT_LABELS: Record<MindFont, string> = {
  sans: '系统无衬线', serif: '系统衬线', mono: '系统等宽',
  'noto-sans-sc': 'Noto Sans SC · 中文黑体', 'noto-serif-sc': 'Noto Serif SC · 中文宋体',
  'lxgw-wenkai': '霞鹜文楷', inter: 'Inter · 西文无衬线', 'jetbrains-mono': 'JetBrains Mono · 代码等宽',
};
const hues = { blue: 'var(--content-blue)', sage: 'var(--content-sage)', sand: 'var(--content-sand)', rose: 'var(--content-rose)', lavender: 'var(--content-lavender)' };
export function mindColor(color: MindColor | null | undefined, background = false): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('#')) return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
  if (color === 'neutral') return background ? 'var(--surface)' : 'var(--foreground)';
  const hue = hues[color as keyof typeof hues];
  return hue ? `color-mix(in srgb, ${hue} ${background ? '14%' : '65%'}, var(--${background ? 'background' : 'foreground'}))` : undefined;
}

/** Choose readable default text when a user supplies a literal background color. */
function contrastText(background: string | null | undefined): string | undefined {
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return undefined;
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const value = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722 > 0.179 ? 'var(--text-on-custom-light)' : 'var(--text-on-custom-dark)';
}

export function titleAppearance(task: Task, _depth = 2, inheritedFont?: MindFont | null): CSSProperties {
  const family = task.mindFontFamily ?? inheritedFont ?? DEFAULT_MIND_FONT;
  return {
    fontFamily: FONT_FAMILIES[family],
    fontSize: task.mindFontSize ?? UI_GEOMETRY.nodeTitleSize,
    fontWeight: task.mindBold == null ? UI_GEOMETRY.nodeTitleWeight : task.mindBold ? 700 : 400,
    fontStyle: task.mindItalic ? 'italic' : 'normal',
    lineHeight: UI_GEOMETRY.nodeTitleLeading / UI_GEOMETRY.nodeTitleSize,
    color: mindColor(task.mindTextColor) ?? contrastText(task.mindBackground),
  };
}
