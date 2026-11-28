/**
 * 所有时间以 UTC 保存，时间区间一律左闭右开 [from, until)。
 */

export function ms(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new TypeError(`非法时间: ${String(value)}`);
  return t;
}

export function iso(value) {
  return new Date(ms(value)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 两个左闭右开区间是否相交。 */
export function overlaps(a, b) {
  return ms(a.from) < ms(b.until) && ms(b.from) < ms(a.until);
}

/** 点 t 是否落在区间内（左闭右开）。 */
export function contains(interval, t) {
  return ms(interval.from) <= ms(t) && ms(t) < ms(interval.until);
}

/**
 * 在按施行时间排序的版本列表中，选取 t 时刻生效的版本（最后一个 from <= t）。
 * 没有任何版本时返回 null。
 */
export function activeAt(versions, t) {
  const at = ms(t);
  let picked = null;
  for (const version of versions) {
    if (ms(version.from) <= at) picked = version;
    else break;
  }
  return picked;
}

/** 把区间裁剪到 window 内，不相交返回 null。 */
export function clip(interval, window) {
  const from = Math.max(ms(interval.from), ms(window.from));
  const until = Math.min(ms(interval.until), ms(window.until));
  if (from >= until) return null;
  return { from: iso(from), until: iso(until) };
}

/**
 * 合并若干区间（自动裁剪到 window），返回互不相交、按起点排序的覆盖段。
 */
export function mergeCover(intervals, window) {
  const clipped = intervals
    .map((item) => clip(item, window))
    .filter((item) => item !== null)
    .sort((a, b) => ms(a.from) - ms(b.from));
  const merged = [];
  for (const item of clipped) {
    const last = merged[merged.length - 1];
    // 左闭右开：前段 until 等于后段 from 属于无缝接续，也要合并。
    if (last && ms(item.from) <= ms(last.until)) {
      last.until = iso(Math.max(ms(last.until), ms(item.until)));
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

/**
 * 计算 window 减去 covered 后的缺口区间。
 */
export function gapsOf(window, covered) {
  const result = [];
  let cursor = ms(window.from);
  const end = ms(window.until);
  for (const segment of mergeCover(covered, window)) {
    const segFrom = ms(segment.from);
    if (segFrom > cursor) {
      result.push({ from: iso(cursor), until: iso(segFrom) });
    }
    cursor = Math.max(cursor, ms(segment.until));
  }
  if (cursor < end) result.push({ from: iso(cursor), until: iso(end) });
  return result;
}

/** 区间是否完整覆盖 window（允许由多段无缝拼接）。 */
export function coversFully(intervals, window) {
  return gapsOf(window, intervals).length === 0;
}
