import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps/web/src', 'packages/ui/src'];
const errors = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!/\.(css|tsx?)$/.test(path) || path.endsWith('/tokens.css')) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const fail = (message) => errors.push(`${path}:${index + 1}: ${message}`);
      if (/["'\s:(\[]#[\da-f]{3,8}(?=["'\s;)\]])/i.test(line) || /\b(?:rgba?|hsla?)\(\s*\d/.test(line)) fail('Use a semantic color token');
      if (/\b(?:bg|text|border|ring|fill|stroke)-(?:black|white|gray|zinc|neutral|stone|slate|blue|indigo|purple|violet|cyan|teal|emerald|green|yellow|amber|orange|red|rose|pink)(?:[/-]|\b)/.test(line)) fail('Use a semantic utility, not a raw palette');
      if (/shadow-\[(?!var\(--shadow-)/.test(line) || /(?:box-shadow|boxShadow)\s*:\s*["']?(?!var\(|none)[\d-]/.test(line)) fail('Use one of the three elevation tokens');
      for (const match of line.matchAll(/\b(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?)-\[([\d.]+)px\]/g)) {
        if (Number(match[1]) % 2 !== 0) fail('Spacing must follow the 4px / 2px grid');
        else fail('Name arbitrary spacing with a semantic token or use a grid utility');
      }
      for (const match of line.matchAll(/\bduration-(\d+)\b|\bduration:\s*(\d{3,})\b/g)) {
        if (Number(match[1] ?? match[2]) > 180) fail('UI transitions must finish within 180ms');
      }
    });
  }
}
roots.forEach(walk);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('UI tokens: colors, elevations, spacing utilities and motion comply.');
