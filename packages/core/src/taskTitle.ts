export interface TaskTitlePart { text: string; href?: string; source?: string }

/** Title links never execute code or read local files. No remote metadata is fetched. */
export function safeTaskHref(value: string): string | undefined {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return;
  if (/^\/(?!\/)/.test(value) || value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) return value;
  } catch { /* Keep malformed links as literal text. */ }
}
const unescape = (value: string) => value.replace(/\\([\\\[\]()<>])/g, '$1');

/** A small inline-link parser, shared by renderers and map text measurement. */
export function parseTaskTitle(title: string): TaskTitlePart[] {
  const parts: TaskTitlePart[] = [];
  const plain = (value: string) => {
    let from = 0;
    for (const match of value.matchAll(/(?:https?:\/\/|mailto:)[^\s<>]+/gi)) {
      const start = match.index!;
      let url = match[0].replace(/[.,;:!?。，；：！？、”’」』]+$/, '');
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
      }
      const href = safeTaskHref(url);
      if (!href) continue;
      if (start > from) parts.push({ text: value.slice(from, start) });
      parts.push({ text: url, href, source: url }); from = start + url.length;
    }
    if (from < value.length) parts.push({ text: value.slice(from) });
  };
  let cursor = 0, literal = 0;
  while (cursor < title.length) {
    if (title[cursor] === '\\') { cursor += 2; continue; }
    if (title[cursor] !== '[' || title[cursor - 1] === '!') { cursor++; continue; }
    const start = cursor;
    let endLabel = cursor + 1;
    while (endLabel < title.length && title[endLabel] !== '\n') {
      if (title[endLabel] === '\\') { endLabel += 2; continue; }
      if (title[endLabel] === ']') break;
      endLabel++;
    }
    if (title.slice(endLabel, endLabel + 2) !== '](') { cursor = Math.max(cursor + 1, endLabel); continue; }
    let end = endLabel + 2, depth = 1;
    while (end < title.length && title[end] !== '\n') {
      if (title[end] === '\\') { end += 2; continue; }
      if (title[end] === '(') depth++;
      if (title[end] === ')' && --depth === 0) break;
      end++;
    }
    let target = title.slice(endLabel + 2, end).trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    const href = title[end] === ')' ? safeTaskHref(unescape(target)) : undefined;
    cursor = Math.max(end + 1, endLabel + 2);
    if (!href) continue;
    plain(title.slice(literal, start));
    parts.push({ text: unescape(title.slice(start + 1, endLabel)) || href, href, source: title.slice(start, cursor) });
    literal = cursor;
  }
  plain(title.slice(literal));
  return parts;
}
export const taskTitleText = (title: string) => parseTaskTitle(title).map(part => part.text).join('');
