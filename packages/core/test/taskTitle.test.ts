import { expect, it } from 'vitest';
import { parseTaskTitle, safeTaskHref, taskTitleText } from '../src/taskTitle';

it('renders mixed Markdown links, balanced URL parentheses, Chinese labels and plain URLs', () => {
  expect(parseTaskTitle('阅读 [并发教程](https://example.com/Foo_(bar))，参考 https://example.com/b。').map(({ source, ...part }) => part)).toEqual([
    { text: '阅读 ' }, { text: '并发教程', href: 'https://example.com/Foo_(bar)' }, { text: '，参考 ' },
    { text: 'https://example.com/b', href: 'https://example.com/b' }, { text: '。' },
  ]);
  expect(taskTitleText('[中文\\[标签\\]](<https://example.com/a(b)>)')).toBe('中文[标签]');
  expect(parseTaskTitle('https://example.com?a=1&b=2#section')[0]?.href).toBe('https://example.com?a=1&b=2#section');
});
it('rejects executable or local URLs and preserves malformed syntax without HTML interpretation', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//example.com', 'https://user:secret@example.com', 'https://example.com/\nunsafe', '/\\evil.com']) expect(safeTaskHref(href)).toBeUndefined();
  for (const title of ['[坏链接](javascript:alert(1))', '[坏链接](data:text/html,x)', '[未完成](foo', '<script>alert(1)</script>']) expect(taskTitleText(title)).toBe(title);
  expect(safeTaskHref('/tasks?focusTask=id')).toBe('/tasks?focusTask=id');
  expect(taskTitleText('普通标题')).toBe('普通标题');
});
