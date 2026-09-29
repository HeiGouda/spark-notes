// 生成性能验收用的笔记库：1 万篇笔记，一半带图片附件（需求文档 7.1）
// 用法：node scripts/perf/gen-vault.mjs <目录>   （目录会被清空重建，请使用临时目录）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.argv[2];
if (!root) throw new Error("用法：node scripts/perf/gen-vault.mjs <目录>");
const MARKER = ".ttnote-perf-vault";
// 只清空由本脚本生成过的目录或空目录，避免误删真实笔记库
if (fs.existsSync(root) && fs.readdirSync(root).length && !fs.existsSync(path.join(root, MARKER))) {
  throw new Error(`${root} 不是空目录，也不是本脚本生成的测试库，拒绝清空`);
}
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, MARKER), "");

const FOLDERS = 100;
const PER_FOLDER = 100;
const words = "同步 冲突 索引 搜索 编辑器 笔记 附件 标签 链接 版本 历史 回收站 性能 内存 启动 渲染 主题 快捷键 命令 面板".split(" ");
const en = "sync conflict index search editor note attachment tag link version history performance memory render".split(" ");

/** 生成一张 64x64 的真实 PNG（约 12KB，带噪点避免被压得太小） */
function png(seed) {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let s = seed;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      raw[y * (w * 3 + 1) + 1 + x] = s >>> 24;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let rnd = 42;
const r = (n) => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) % n);
const pick = (a) => a[r(a.length)];

let count = 0;
for (let f = 0; f < FOLDERS; f++) {
  const dir = path.join(root, `分类${String(f).padStart(3, "0")}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PER_FOLDER; i++) {
    const name = `笔记${f}-${i}`;
    const paras = [];
    for (let p = 0; p < 6; p++) {
      let line = "";
      for (let k = 0; k < 40; k++) line += pick(words) + (k % 5 === 0 ? ` ${pick(en)} ` : "");
      paras.push(line + "。");
    }
    const link = `[[笔记${r(FOLDERS)}-${r(PER_FOLDER)}]]`;
    let body = `---\ntags: [${pick(words)}, 分类${f}]\ncreated: 2026-09-01T10:00:00+08:00\n---\n\n## ${pick(words)}\n\n${paras.slice(0, 3).join("\n\n")}\n\n相关：${link} #${pick(words)}\n\n\`\`\`rust\nfn main() { println!("${name}"); }\n\`\`\`\n\n${paras.slice(3).join("\n\n")}\n`;
    if (count % 2 === 0) {
      const assets = path.join(dir, `${name}.assets`);
      fs.mkdirSync(assets);
      fs.writeFileSync(path.join(assets, "image.png"), png(count + 1));
      body += `\n![图](${name}.assets/image.png)\n`;
    }
    fs.writeFileSync(path.join(dir, `${name}.md`), body);
    count++;
  }
}
// 一篇接近 1MB 的大笔记，用于“打开单篇笔记（< 1MB）”
let big = "# 大笔记\n\n";
while (Buffer.byteLength(big) < 950 * 1024) big += `${pick(words)}${pick(words)}${pick(en)} `.repeat(20) + "\n\n";
fs.writeFileSync(path.join(root, "大笔记.md"), big);
console.log(`生成 ${count} 篇笔记 + 1 篇大笔记于 ${root}`);
