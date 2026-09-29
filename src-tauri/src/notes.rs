//! 笔记内容解析（不依赖数据库）：Front Matter、标签、双向链接、中文二元切分、搜索语法、摘要、链接解析。
//! 标签与链接规则需与前端 `src/editor/wikilink.ts` 保持一致。

use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub body: String,
    pub tags: Vec<String>,
    pub links: Vec<LinkRef>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkRef {
    /// `[[ ]]` 中的完整内容
    pub raw: String,
    /// 去掉 `#标题` 和 `|别名` 后的目标
    pub target: String,
    /// 链接所在行，用于反向链接的上下文
    pub line: String,
}

/// 与前端 frontmatter.ts 一致：以 `---` 行开始、`---` 行结束
pub fn split_front_matter(src: &str) -> (&str, &str) {
    let s = src.strip_prefix('\u{feff}').unwrap_or(src);
    let offset = src.len() - s.len();
    let first_end = match s.find('\n') {
        Some(i) => i,
        None => return ("", src),
    };
    if s[..first_end].trim_end() != "---" {
        return ("", src);
    }
    let mut pos = first_end + 1;
    while pos <= s.len() {
        let end = s[pos..].find('\n').map(|i| pos + i).unwrap_or(s.len());
        if s[pos..end].trim_end() == "---" {
            let body_start = (end + 1).min(s.len());
            return (&src[..offset + body_start], &src[offset + body_start..]);
        }
        if end >= s.len() {
            break;
        }
        pos = end + 1;
    }
    ("", src)
}

fn unquote(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(t);
    let t = t.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).unwrap_or(t);
    t.trim().trim_start_matches('#').to_string()
}

pub fn front_matter_tags(fm: &str) -> Vec<String> {
    let lines: Vec<&str> = fm.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(rest) = lines[i].trim_end().strip_prefix("tags:") {
            let v = rest.trim();
            if let Some(inner) = v.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
                out.extend(inner.split(',').map(unquote).filter(|s| !s.is_empty()));
            } else if !v.is_empty() {
                out.extend(v.split(',').map(unquote).filter(|s| !s.is_empty()));
            } else {
                while i + 1 < lines.len() {
                    let l = lines[i + 1].trim_start();
                    let Some(item) = l.strip_prefix("- ") else { break };
                    let t = unquote(item);
                    if !t.is_empty() {
                        out.push(t);
                    }
                    i += 1;
                }
            }
        }
        i += 1;
    }
    out
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// 行内 `#标签`：`#` 前是行首或空白，标签至少含一个非数字字符
fn inline_tags(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
            let start = i + 1;
            let mut j = start;
            while j < chars.len() && is_tag_char(chars[j]) {
                j += 1;
            }
            let tag: String = chars[start..j].iter().collect();
            let tag = tag.trim_end_matches('/');
            if !tag.is_empty() && tag.chars().any(|c| !c.is_ascii_digit()) {
                out.push(tag.to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
}

fn wiki_links(line: &str, context: &str, out: &mut Vec<LinkRef>) {
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        if !inner.is_empty() && !inner.contains('[') && !inner.contains(']') {
            let target = inner.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
            out.push(LinkRef { raw: inner.to_string(), target: target.to_string(), line: context.to_string() });
            rest = &after[end + 2..];
        } else {
            rest = &rest[start + 2..];
        }
    }
}

/// 改写正文中的双向链接。Front Matter、围栏代码块和行内代码保持原样，换行符也不变。
/// `replace` 收到 `[[` 与 `]]` 之间的原文，返回新内容；`None` 表示这一处不改。
pub fn map_wikilinks(content: &str, mut replace: impl FnMut(&str) -> Option<String>) -> String {
    let (fm, mut rest) = split_front_matter(content);
    let mut out = String::with_capacity(content.len());
    out.push_str(fm);
    let mut fence: Option<&str> = None;
    while !rest.is_empty() {
        let (line, sep, next) = split_line(rest);
        rest = next;
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            out.push_str(line);
            out.push_str(sep);
            if trimmed.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            out.push_str(line);
            out.push_str(sep);
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            out.push_str(line);
            out.push_str(sep);
            continue;
        }
        out.push_str(&map_line_outside_code(line, &mut replace));
        out.push_str(sep);
    }
    out
}

fn split_line(s: &str) -> (&str, &str, &str) {
    match s.find('\n') {
        Some(i) => (&s[..i], "\n", &s[i + 1..]),
        None => (s, "", ""),
    }
}

/// 跳过行内代码（以 `` ` `` 切换）后改写本行的 `[[ ]]`
fn map_line_outside_code(line: &str, replace: &mut impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut pos = 0;
    let mut in_code = false;
    while pos < line.len() {
        let rest = &line[pos..];
        if rest.starts_with('`') {
            in_code = !in_code;
            out.push('`');
            pos += '`'.len_utf8();
            continue;
        }
        if !in_code && rest.starts_with("[[") {
            if let Some(end) = rest[2..].find("]]") {
                let inner = &rest[2..2 + end];
                out.push_str("[[");
                match replace(inner) {
                    Some(next) => out.push_str(&next),
                    None => out.push_str(inner),
                }
                out.push_str("]]");
                pos += 2 + end + 2;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        pos += ch.len_utf8();
    }
    out
}

/// 把行内代码替换成空格，避免其中的 `#` 与 `[[ ]]` 被当成标签和链接
fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for c in line.chars() {
        if c == '`' {
            in_code = !in_code;
            out.push(' ');
        } else {
            out.push(if in_code { ' ' } else { c });
        }
    }
    out
}

fn context_of(line: &str) -> String {
    let t = line.trim();
    let t: String = t.chars().take(160).collect();
    t
}

pub fn parse(content: &str) -> Parsed {
    let (fm, body) = split_front_matter(content);
    let mut tags = front_matter_tags(fm);
    let mut links = Vec::new();
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(f) = fence {
            if trimmed.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        let clean = strip_inline_code(line);
        inline_tags(&clean, &mut tags);
        wiki_links(&clean, &context_of(line), &mut links);
    }
    let mut seen = std::collections::HashSet::new();
    tags.retain(|t| seen.insert(t.to_lowercase()));
    Parsed { body: body.to_string(), tags, links }
}

/* ---------- 中文二元切分 ---------- */

pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xAC00..=0xD7AF | 0x20000..=0x2FA1F)
}

fn push_run(out: &mut String, run: &[char]) {
    match run.len() {
        0 => {}
        1 => {
            out.push(' ');
            out.push(run[0]);
            out.push(' ');
        }
        _ => {
            for w in run.windows(2) {
                out.push(' ');
                out.push(w[0]);
                out.push(w[1]);
            }
            out.push(' ');
        }
    }
}

/// 写入索引前的切分：连续的中日韩字符按相邻两字切成词元，其余文字交给 FTS5 的 unicode61 分词
pub fn tokenize(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut run: Vec<char> = Vec::new();
    for c in text.chars() {
        if is_cjk(c) {
            run.push(c);
        } else {
            push_run(&mut out, &run);
            run.clear();
            out.push(c);
        }
    }
    push_run(&mut out, &run);
    out
}

#[derive(Debug, Default, PartialEq)]
pub struct Query {
    /// FTS5 MATCH 表达式；只有过滤条件时为 None
    pub fts: Option<String>,
    pub tags: Vec<String>,
    pub folders: Vec<String>,
    /// 用于生成摘要高亮的原始词
    pub terms: Vec<String>,
}

fn term_parts(term: &str, parts: &mut Vec<String>) {
    let mut run: Vec<char> = Vec::new();
    let mut word = String::new();
    let flush_run = |run: &mut Vec<char>, parts: &mut Vec<String>| {
        match run.len() {
            0 => {}
            1 => parts.push(format!("\"{}\"*", run[0])),
            _ => parts.push(format!(
                "\"{}\"",
                run.windows(2).map(|w| w.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
            )),
        }
        run.clear();
    };
    for c in term.chars() {
        if is_cjk(c) {
            if !word.is_empty() {
                parts.push(format!("\"{}\"*", word.to_lowercase()));
                word.clear();
            }
            run.push(c);
        } else if c.is_alphanumeric() {
            flush_run(&mut run, parts);
            word.push(c);
        } else {
            flush_run(&mut run, parts);
            if !word.is_empty() {
                parts.push(format!("\"{}\"*", word.to_lowercase()));
                word.clear();
            }
        }
    }
    flush_run(&mut run, parts);
    if !word.is_empty() {
        parts.push(format!("\"{}\"*", word.to_lowercase()));
    }
}

/// 搜索语法：空格分隔的词都要出现；`#标签` 按标签过滤；`path:文件夹` 按文件夹过滤
pub fn parse_query(q: &str) -> Query {
    let mut out = Query::default();
    let mut parts = Vec::new();
    for tok in q.split_whitespace() {
        if let Some(tag) = tok.strip_prefix('#').filter(|t| !t.is_empty()) {
            out.tags.push(tag.trim_end_matches('/').to_string());
        } else if let Some(dir) = tok.strip_prefix("path:").filter(|t| !t.is_empty()) {
            out.folders.push(dir.trim_matches('/').replace('\\', "/"));
        } else {
            out.terms.push(tok.to_string());
            term_parts(tok, &mut parts);
        }
    }
    if !parts.is_empty() {
        out.fts = Some(parts.join(" "));
    }
    out
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Segment {
    pub text: String,
    pub hit: bool,
}

/// 生成命中片段：从第一个命中位置前后截取，并标出所有命中
pub fn snippet(body: &str, terms: &[String], width: usize) -> Vec<Segment> {
    let flat: Vec<char> = body
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    let lower: Vec<char> = flat.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let needles: Vec<Vec<char>> = terms
        .iter()
        .map(|t| t.to_lowercase().chars().collect::<Vec<_>>())
        .filter(|t| !t.is_empty())
        .collect();
    let find_at = |i: usize| needles.iter().find(|n| lower[i..].starts_with(n)).map(|n| n.len());
    let first = (0..lower.len()).find(|&i| find_at(i).is_some()).unwrap_or(0);
    let start = first.saturating_sub(width / 4);
    let end = (start + width).min(flat.len());
    let mut segs: Vec<Segment> = Vec::new();
    let mut push = |text: String, hit: bool| {
        if let Some(last) = segs.last_mut().filter(|s| s.hit == hit) {
            last.text.push_str(&text);
        } else if !text.is_empty() {
            segs.push(Segment { text, hit });
        }
    };
    if start > 0 {
        push("…".into(), false);
    }
    let mut i = start;
    while i < end {
        if let Some(n) = find_at(i) {
            let stop = (i + n).min(end);
            push(flat[i..stop].iter().collect(), true);
            i = stop;
        } else {
            push(flat[i].to_string(), false);
            i += 1;
        }
    }
    if end < flat.len() {
        push("…".into(), false);
    }
    segs
}

/* ---------- 链接解析 ---------- */

fn strip_md(p: &str) -> &str {
    if p.len() > 3 && p[p.len() - 3..].eq_ignore_ascii_case(".md") {
        &p[..p.len() - 3]
    } else {
        p
    }
}

fn dir_of(p: &str) -> &str {
    p.rfind('/').map(|i| &p[..i]).unwrap_or("")
}

fn stem_of(p: &str) -> &str {
    let s = strip_md(p);
    s.rfind('/').map(|i| &s[i + 1..]).unwrap_or(s)
}

fn normalize_rel(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            x => out.push(x),
        }
    }
    out.join("/")
}

/// 笔记路径的查找表：批量解析链接时，不必每条链接都把全部路径转一遍小写再逐个比较
pub struct LinkIndex<'a> {
    all: &'a [String],
    /// 去掉 `.md` 的小写路径 → 第一个匹配的下标
    by_path: HashMap<String, usize>,
    /// 小写笔记名 → 所有同名笔记的下标
    by_stem: HashMap<String, Vec<usize>>,
}

impl<'a> LinkIndex<'a> {
    pub fn new(all: &'a [String]) -> Self {
        let mut by_path = HashMap::with_capacity(all.len());
        let mut by_stem: HashMap<String, Vec<usize>> = HashMap::with_capacity(all.len());
        for (i, p) in all.iter().enumerate() {
            by_path.entry(strip_md(p).to_lowercase()).or_insert(i);
            by_stem.entry(stem_of(p).to_lowercase()).or_default().push(i);
        }
        Self { all, by_path, by_stem }
    }

    /// 按笔记名或路径解析链接目标：带路径时按笔记库相对路径（其次相对当前笔记所在文件夹）匹配；
    /// 只写笔记名时，优先同一文件夹，其次路径最短的
    pub fn resolve(&self, target: &str, src: &str) -> Option<&'a String> {
        let t = strip_md(target.trim()).replace('\\', "/");
        if t.is_empty() {
            return None;
        }
        let tl = t.to_lowercase();
        if t.contains('/') {
            let abs = normalize_rel(&tl);
            let rel = normalize_rel(&format!("{}/{}", dir_of(src), tl).to_lowercase());
            return self.by_path.get(&abs).or_else(|| self.by_path.get(&rel)).map(|&i| &self.all[i]);
        }
        let src_dir = dir_of(src);
        self.by_stem
            .get(&tl)?
            .iter()
            .map(|&i| &self.all[i])
            .min_by_key(|p| (dir_of(p) != src_dir, p.matches('/').count(), p.to_lowercase()))
    }
}

#[cfg(test)]
pub fn resolve_link<'a>(target: &str, src: &str, all: &'a [String]) -> Option<&'a String> {
    LinkIndex::new(all).resolve(target, src)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_split_and_tags() {
        let src = "---\ntags: [工作, \"周报\"]\n---\n\n正文 #行内 #工作\n";
        let (fm, body) = split_front_matter(src);
        assert_eq!(fm, "---\ntags: [工作, \"周报\"]\n---\n");
        assert_eq!(body, "\n正文 #行内 #工作\n");
        assert_eq!(parse(src).tags, vec!["工作", "周报", "行内"]);
        assert_eq!(front_matter_tags("tags:\n  - a\n  - 'b'\n"), vec!["a", "b"]);
        assert_eq!(split_front_matter("---\n未闭合"), ("", "---\n未闭合"));
    }

    #[test]
    fn inline_tags_rules() {
        let p = parse("# 标题\n#层级/子/ 与#不是 #123 #v2 `#代码` a#b\n```\n#围栏\n```\n");
        assert_eq!(p.tags, vec!["层级/子", "v2"]);
    }

    #[test]
    fn links_with_heading_alias_and_context() {
        let p = parse("见 [[周报#本周|别名]] 和 [[工作/周报]]，`[[代码]]`\n");
        assert_eq!(p.links.len(), 2);
        assert_eq!(p.links[0].target, "周报");
        assert_eq!(p.links[0].raw, "周报#本周|别名");
        assert_eq!(p.links[1].target, "工作/周报");
        assert!(p.links[0].line.starts_with("见 [[周报"));
    }

    #[test]
    fn bigram_tokenize() {
        assert_eq!(tokenize("同步设计"), " 同步 步设 设计 ");
        assert_eq!(tokenize("用WebDAV同步"), " 用 WebDAV 同步 ");
        assert_eq!(tokenize("a"), "a");
    }

    #[test]
    fn query_syntax() {
        let q = parse_query("同步 WebDAV #工作 path:工作/TT笔记 设");
        assert_eq!(q.fts.as_deref(), Some("\"同步\" \"webdav\"* \"设\"*"));
        assert_eq!(q.tags, vec!["工作"]);
        assert_eq!(q.folders, vec!["工作/TT笔记"]);
        assert_eq!(parse_query("同步设计").fts.as_deref(), Some("\"同步 步设 设计\""));
        assert_eq!(parse_query("#工作").fts, None);
        assert_eq!(parse_query("a\"b").fts.as_deref(), Some("\"a\"* \"b\"*"));
    }

    #[test]
    fn snippet_marks_hits() {
        let segs = snippet("开头\n这里讲 WebDAV 同步规则", &["同步".into(), "webdav".into()], 40);
        let hits: Vec<_> = segs.iter().filter(|s| s.hit).map(|s| s.text.as_str()).collect();
        assert_eq!(hits, vec!["WebDAV", "同步"]);
        assert!(!segs.iter().any(|s| s.text.contains('\n')));
    }

    #[test]
    fn resolve_prefers_same_folder_then_shortest() {
        let all: Vec<String> = ["a/周报.md", "b/c/周报.md", "周报.md", "工作/项目.md"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_link("周报", "a/x.md", &all).unwrap(), "a/周报.md");
        assert_eq!(resolve_link("周报", "z/x.md", &all).unwrap(), "周报.md");
        assert_eq!(resolve_link("b/c/周报", "x.md", &all).unwrap(), "b/c/周报.md");
        assert_eq!(resolve_link("c/周报.md", "b/x.md", &all).unwrap(), "b/c/周报.md");
        assert_eq!(resolve_link("项目", "x.md", &all).unwrap(), "工作/项目.md");
        assert_eq!(resolve_link("A/周报.MD", "x.md", &all).unwrap(), "a/周报.md");
        assert_eq!(resolve_link("../周报", "a/x.md", &all).unwrap(), "周报.md");
        assert!(resolve_link("不存在", "x.md", &all).is_none());
    }

    #[test]
    fn map_wikilinks_skips_front_matter_and_code() {
        let src = "---\nsee: [[周报]]\n---\n正文 [[周报]]\r\n`[[周报]]`\n```md\n[[周报]]\n```\n~~~\n[[周报]]\n~~~\n";
        let out = map_wikilinks(src, |inner| inner.eq("周报").then(|| "总结".to_string()));
        assert_eq!(out, "---\nsee: [[周报]]\n---\n正文 [[总结]]\r\n`[[周报]]`\n```md\n[[周报]]\n```\n~~~\n[[周报]]\n~~~\n");
    }
}
