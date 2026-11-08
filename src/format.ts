/** m:ss.s, e.g. 1:02.0 */
export function formatTime(seconds: number): string {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** For screen readers, e.g. "1 minute 13 seconds". */
export function spokenTime(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const m = Math.floor(t / 60);
  const s = t % 60;
  const parts: string[] = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}
