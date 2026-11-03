/** Short, local calendar labels shared by task pages and conversation decisions. */
export function formatTime(
  value: string | number | Date | undefined,
  style: 'relative' | 'elapsed' | 'clock' | 'day' | 'list' = 'relative',
  now: Date = new Date(),
) {
  if (value === undefined) return 'Unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  if (style === 'clock')
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = date.toDateString() === now.toDateString();
  const previousDay = date.toDateString() === yesterday.toDateString();
  if (style === 'list') {
    if (now.getTime() - date.getTime() < 60000) return 'now';
    if (sameDay)
      return `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (previousDay) return 'Yesterday';
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);
    if (date >= weekAgo) return date.toLocaleDateString('en-US', { weekday: 'short' });
    return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}`;
  }
  if (style === 'day') {
    if (sameDay) return 'Today';
    if (previousDay) return 'Yesterday';
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 6);
    if (date >= weekAgo && date < today)
      return date.toLocaleDateString('en-US', { weekday: 'long' });
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
    });
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (style === 'relative' && seconds < 60) return 'Just now';
  if (style === 'relative' && previousDay) return 'Yesterday';
  const amount =
    seconds < 60
      ? `${seconds} s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} min`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} hr`
          : `${Math.floor(seconds / 86400)} ${seconds < 172800 ? 'day' : 'days'}`;
  return style === 'elapsed' ? amount : `${amount} ago`;
}
