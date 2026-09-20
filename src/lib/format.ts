/**
 * 时间格式化：数据库统一存 UTC，展示固定按 Asia/Shanghai。
 * 为什么单独一个文件：时区是最容易在"本地正常、服务器错 8 小时"的地方翻车，
 * 因此只允许从这一处格式化时间。
 */
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: Date | string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function formatTime(value: Date | string): string {
  return timeFormatter.format(new Date(value));
}

/** 用于列表页的"多久以前" */
export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  return `${Math.round(hours / 24)} 天前`;
}
