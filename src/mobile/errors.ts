/** 系统和网络库给的英文报错换成中文，原文里的中文说明保留 */
const RULES: [RegExp, string][] = [
  [/no such file or directory(?: \(os error 2\))?/i, "找不到文件"],
  [/permission denied(?: \(os error 13\))?/i, "没有权限访问这个文件"],
  [/no space left on device(?: \(os error 28\))?/i, "手机存储空间不足"],
  [/(?:operation |connection )?timed out[^，。]*|timeout[^，。]*/i, "网络超时，请稍后再试"],
  [/failed to fetch|networkerror when attempting to fetch resource|load failed/i, "网络请求失败"],
  [/connection refused(?: \(os error 111\))?/i, "服务器拒绝连接"],
  [/connection reset(?: by peer)?(?: \(os error 104\))?/i, "连接被服务器断开"],
  [/network is unreachable(?: \(os error 101\))?/i, "网络不可用"],
  [/(?:dns error|failed to lookup address information|name or service not known|no address associated with hostname)[^，。]*/i, "找不到服务器，请检查网址和网络"],
  [/invalid certificate|certificate verify failed|unknown ?issuer/i, "服务器证书无效"],
  [/unexpected end of file|unexpected eof/i, "连接中断，文件没有传完"],
  [/out of memory/i, "内存不足"],
  [/is not a function|cannot read properties of (?:null|undefined)[^，。]*/i, "页面出错了"],
];

export function zhError(text: string): string {
  let out = text;
  for (const [re, zh] of RULES) out = out.replace(re, zh);
  return out;
}
