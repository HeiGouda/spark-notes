/** 提交记录上的时间：今天 / 昨天带时刻，更早只写日期。 */

export function formatGitWhen(unixSec: number, now = new Date()): string {
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const ymd = (dt: Date) => dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
  const today = ymd(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (ymd(d) === today) return `今天 ${hm}`;
  if (ymd(d) === ymd(yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
