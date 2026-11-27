import { Priority } from './types';
import { addDays, dayKeyOf, nextWeekday, startOfDay } from './time';
import { parseTaskTitle } from './taskTitle';

/**
 * Quick Capture 内联语法(全是加速器,不强制):
 *   #tag 标签(可多个)
 *   !P0..!P3 或 !(=P1) !!(=P0)
 *   ~90m / ~2h 预估时长
 *   @今天 @明天 @后天 / @today @tomorrow @mon..@sun / @2026-09-01
 *   日期后可跟 @21:30 / @9:05 设定当天时刻(无日期时默认今天)
 */
export interface ParsedCapture {
  title: string;
  tags: string[];
  priority?: Priority;
  startAt?: number;
  dueAt?: number;
  estimateMin?: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  mon: 1, monday: 1, 周一: 1, 一: 1,
  tue: 2, tuesday: 2, 周二: 2, 二: 2,
  wed: 3, wednesday: 3, 周三: 3, 三: 3,
  thu: 4, thursday: 4, 周四: 4, 四: 4,
  fri: 5, friday: 5, 周五: 5, 五: 5,
  sat: 6, saturday: 6, 周六: 6, 六: 6,
  sun: 7, sunday: 7, 周日: 7, 日: 7, 天: 7,
};

const DAY_TOKENS: Record<string, number> = {
  today: 0, 今天: 0,
  tomorrow: 1, 明天: 1, tm: 1,
  后天: 2,
};

export function parseCapture(input: string, now: Date = new Date()): ParsedCapture {
  // Link labels may contain #issue, @today or !P0 as ordinary text.
  let marker = '\uE000';
  while (input.includes(marker)) marker += '\uE000';
  const links: string[] = [];
  input = parseTaskTitle(input).map(part => {
    if (!part.href) return part.text;
    links.push(part.source ?? part.text);
    return `${marker}${links.length - 1}${marker}`;
  }).join('');
  const tags: string[] = [];
  let priority: Priority | undefined;
  let estimateMin: number | undefined;
  // 用 holder 对象避免闭包内赋值导致的控制流收窄问题
  const slot: { day: Date | null; time: { h: number; m: number } | null } = { day: null, time: null };
  const day = () => slot.day;
  const timeHHMM = () => slot.time;

  let text = input.replace(/(^|\s)#(\S+)/g, (_m, _s, tag) => {
    tags.push(tag);
    return ' ';
  });

  text = text.replace(/(^|\s)!!?(?=\s|$)/g, (m, _s) => {
    priority = m.trim() === '!!' ? 'P0' : 'P1';
    return ' ';
  });

  text = text.replace(/(^|\s)!p([0-3])(?=\s|$)/gi, (_m, _s, p) => {
    priority = `P${p}` as Priority;
    return ' ';
  });

  text = text.replace(/(^|\s)~(\d+(?:\.\d+)?)(m|min|h|hr|hour)(s)?(?=\s|$)/gi, (_m, _s, n, unit) => {
    const v = parseFloat(n);
    estimateMin = unit.toLowerCase().startsWith('h') ? Math.round(v * 60) : Math.round(v);
    return ' ';
  });

  // @token(可多个:日期在前,时刻在后;或仅时刻)
  text = text.replace(/(^|\s)@(\S+)/g, (_m, _s, raw) => {
    const token = raw.toLowerCase();
    if (/^\d{1,2}:\d{2}$/.test(token)) {
      const [h, mm] = token.split(':').map(Number);
      if (h! <= 23 && mm! <= 59) slot.time = { h: h!, m: mm! };
      return ' ';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      const d = new Date(`${token}T00:00:00`);
      if (!Number.isNaN(d.getTime())) slot.day = startOfDay(d);
      return ' ';
    }
    if (token in DAY_TOKENS) {
      slot.day = addDays(startOfDay(now), DAY_TOKENS[token]!);
      return ' ';
    }
    if (token in WEEKDAY_MAP) {
      slot.day = nextWeekday(now, WEEKDAY_MAP[token]!);
      return ' ';
    }
    return _m; // 未识别的 @ 保留原样(可能是 @提及)
  });

  let startAt: number | undefined, dueAt: number | undefined;
  if (day() || timeHHMM()) {
    const base = day() ?? startOfDay(now);
    if (timeHHMM()) base.setHours(timeHHMM()!.h, timeHHMM()!.m, 0, 0);
    // 纯时刻且已过今天的该时刻 → 视为明天
    if (!day() && timeHHMM() && base.getTime() < now.getTime()) base.setDate(base.getDate() + 1);
    startAt = startOfDay(base).getTime();
    if (!timeHHMM()) base.setHours(23, 59, 0, 0);
    dueAt = base.getTime();
  }

  let title = text.replace(/\s+/g, ' ').trim();
  links.forEach((link, index) => { title = title.replaceAll(`${marker}${index}${marker}`, link); });
  return {
    title: title || dayKeyOf(now),
    tags: [...new Set(tags)],
    priority,
    startAt,
    dueAt,
    estimateMin,
  };
}
