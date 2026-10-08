//! 从思维导图和流程图文件里取出供全文搜索的文字：节点文字、带文字的连线。
//! 支持的写法与前端 `src/diagram/` 的解析器一致；遇到不支持的写法返回 None，这类文件只按文件名搜索。

use crate::doctype::DocKind;
use std::collections::HashMap;

pub fn extract(kind: DocKind, content: &str) -> Option<String> {
    match kind {
        DocKind::Mind => mind(content),
        DocKind::Flow => flow(content),
        DocKind::Note => None,
    }
}

fn is_comment(t: &str) -> bool {
    t.starts_with("%%")
}

fn mind(content: &str) -> Option<String> {
    let mut lines = content.lines().map(str::trim).filter(|t| !t.is_empty() && !is_comment(t));
    match lines.next() {
        None => return Some(String::new()),
        Some(first) if first.eq_ignore_ascii_case("mindmap") => {}
        Some(_) => return None,
    }
    let mut out = Vec::new();
    for t in lines {
        // 含特殊字符的文字写成 ["文字"]，仍是纯文字节点
        if let Some(inner) = t.strip_prefix("[\"").and_then(|r| r.strip_suffix("\"]")) {
            out.push(format!("节点：{}", decode(inner)));
            continue;
        }
        if t.starts_with("::icon(") || t.contains(":::") || t.contains(['(', ')', '[', ']', '{', '}']) {
            return None;
        }
        out.push(format!("节点：{t}"));
    }
    Some(out.join("\n"))
}

/// 不支持的语句。这些词也可能是普通的节点编号（`end --> x`），与前端 flowchart.ts 的规则一致：
/// `end` 单独占一条语句；`subgraph` 开头；其余的后面要跟参数，而不是连线或节点形状
fn is_unsupported(stmt: &str) -> bool {
    let mut words = stmt.split_whitespace();
    let first = words.next().unwrap_or("").to_ascii_lowercase();
    match first.as_str() {
        "subgraph" => true,
        "end" => words.next().is_none(),
        "direction" | "style" | "classdef" | "class" | "click" | "linkstyle" => {
            words.next().is_some_and(|arg| !arg.starts_with(['-', '=', '.', '<', '~', '(', '[', '{', '>', '@', ':', '|']))
        }
        _ => false,
    }
}

/// 解码实体；多行文字里的 `<br>` 换成空格
fn decode(s: &str) -> String {
    let s = s.replace("<br />", " ").replace("<br/>", " ").replace("<br>", " ");
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(i) = rest.find('#') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        let end = tail.find(';').filter(|&e| e > 0 && e <= 6);
        let decoded = end.and_then(|e| match &tail[..e] {
            "quot" => Some('"'),
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            n => n.parse::<u32>().ok().and_then(char::from_u32),
        });
        match (decoded, end) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &tail[e + 1..];
            }
            _ => {
                out.push('#');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

struct Stmt<'a> {
    s: &'a str,
    i: usize,
}

impl<'a> Stmt<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.i..]
    }

    fn skip_ws(&mut self) {
        let r = self.rest();
        self.i += r.len() - r.trim_start().len();
    }

    /// 读到任一个结尾符号为止
    fn text(&mut self, closes: &[&str]) -> Option<String> {
        let r = self.rest();
        if r.starts_with("\"`") {
            return None;
        }
        let (text, used, close) = if let Some(q) = r.strip_prefix('"') {
            let end = q.find('"')?;
            let close = closes.iter().find(|c| q[end + 1..].starts_with(**c))?;
            (&q[..end], end + 2, *close)
        } else {
            let (end, close) = closes.iter().filter_map(|c| r.find(c).map(|at| (at, *c))).min_by_key(|(at, _)| *at)?;
            let t = &r[..end];
            if t.contains(['"', '(', ')', '[', ']', '{', '}']) {
                return None;
            }
            (t, end, close)
        };
        self.i += used + close.len();
        Some(decode(text.trim()))
    }

    fn node(&mut self) -> Option<(String, Option<String>)> {
        self.skip_ws();
        let r = self.rest();
        let len: usize = r.chars().take_while(|c| c.is_alphanumeric() || *c == '_').map(char::len_utf8).sum();
        if len == 0 {
            return None;
        }
        let id = r[..len].to_string();
        self.i += len;
        let r = self.rest();
        for bad in ["(((", "[[", "[\\", ">", ":::", "@{"] {
            if r.starts_with(bad) {
                return None;
            }
        }
        let shapes: [(&str, &[&str]); 8] = [
            ("((", &["))"]),
            ("([", &["])"]),
            ("(", &[")"]),
            ("[(", &[")]"]),
            ("[/", &["/]", "\\]"]),
            ("[", &["]"]),
            ("{{", &["}}"]),
            ("{", &["}"]),
        ];
        for (open, closes) in shapes {
            if r.starts_with(open) {
                self.i += open.len();
                return self.text(closes).map(|t| (id, Some(t)));
            }
        }
        Some((id, None))
    }

    /// 读一条连线，返回连线文字；语句结束返回 Some(None)；不支持的写法返回 None
    fn edge(&mut self) -> Option<Option<String>> {
        self.skip_ws();
        let r = self.rest();
        if r.is_empty() {
            return Some(None);
        }
        let inline = [("--", "-->", "->"), ("--", "---", "->"), ("-.", ".->", "-"), ("==", "==>", "=>")];
        for (open, close, not_next) in inline {
            if let Some(after) = r.strip_prefix(open) {
                if after.starts_with(|c| not_next.contains(c)) {
                    continue;
                }
                if let Some(end) = after.find(close) {
                    let label = after[..end].trim();
                    if !label.is_empty() && !(close == "---" && after[end + 3..].starts_with(['-', '>'])) {
                        self.i += open.len() + end + close.len();
                        return Some(Some(decode(label.trim_matches('"'))));
                    }
                }
            }
        }
        let plain = ["-->", "-.->", "==>", "---"];
        let arrow = plain.iter().find(|a| r.starts_with(**a))?;
        let after = &r[arrow.len()..];
        if *arrow == "---" && after.starts_with(['-', '>']) {
            return None;
        }
        let mut chars = after.chars();
        if let Some(c) = chars.next() {
            let next_is_id = chars.next().is_some_and(|n| n.is_alphanumeric() || n == '_');
            if "-=.>".contains(c) || ("ox".contains(c) && !next_is_id) {
                return None;
            }
        }
        self.i += arrow.len();
        self.skip_ws();
        let r = self.rest();
        if let Some(p) = r.strip_prefix('|') {
            let (label, used) = if let Some(q) = p.strip_prefix('"') {
                let end = q.find('"')?;
                if !q[end + 1..].starts_with('|') {
                    return None;
                }
                (&q[..end], end + 3)
            } else {
                let end = p.find('|')?;
                (&p[..end], end + 1)
            };
            self.i += 1 + used;
            return Some(Some(decode(label.trim())));
        }
        Some(Some(String::new()))
    }
}

/// 按分号拆分同一行里的多条语句，引号和括号里的分号不算
fn split_statements(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut quoted, mut start) = (0usize, false, 0);
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '(' | '[' | '{' if !quoted => depth += 1,
            ')' | ']' | '}' if !quoted => depth = depth.saturating_sub(1),
            ';' if !quoted && depth == 0 => {
                out.push(&line[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&line[start..]);
    out.into_iter().map(str::trim).filter(|s| !s.is_empty()).collect()
}

fn flow(content: &str) -> Option<String> {
    let mut lines = content.lines().map(str::trim).filter(|t| !t.is_empty() && !is_comment(t));
    let Some(header) = lines.next() else { return Some(String::new()) };
    let word = header.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if word != "flowchart" && word != "graph" {
        return None;
    }
    let mut order: Vec<String> = Vec::new();
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut edges: Vec<(String, String, String)> = Vec::new();
    for line in lines {
        for stmt in split_statements(line) {
            if is_unsupported(stmt) || stmt.contains(":::") {
                return None;
            }
            let mut p = Stmt { s: stmt, i: 0 };
            let mut refs = vec![p.node()?];
            let mut labels = Vec::new();
            while let Some(label) = p.edge()? {
                labels.push(label);
                refs.push(p.node()?);
            }
            for (id, text) in &refs {
                if !texts.contains_key(id) {
                    order.push(id.clone());
                    texts.insert(id.clone(), id.clone());
                }
                if let Some(t) = text {
                    texts.insert(id.clone(), t.clone());
                }
            }
            for (k, label) in labels.into_iter().enumerate() {
                edges.push((refs[k].0.clone(), refs[k + 1].0.clone(), label));
            }
        }
    }
    let mut out: Vec<String> = order.iter().map(|id| format!("节点：{}", texts[id])).collect();
    for (a, b, label) in edges.iter().filter(|e| !e.2.is_empty()) {
        out.push(format!("连线：{} → {}（{label}）", texts[a], texts[b]));
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mind_nodes_and_unsupported() {
        assert_eq!(extract(DocKind::Mind, "mindmap\n  Rust\n    %% 注释\n    所有权\n").unwrap(), "节点：Rust\n节点：所有权");
        assert_eq!(extract(DocKind::Mind, "").unwrap(), "");
        assert!(extract(DocKind::Mind, "mindmap\n  root((中心))\n").is_none());
        assert!(extract(DocKind::Mind, "flowchart TD\n").is_none());
    }

    #[test]
    fn flow_nine_shapes() {
        let src = "flowchart TD\n  %% spark: x=1 y=2\n  a([胶囊]) --> b{{六边形}}\n  c[/平行/] --> d[/梯形\\]\n  e[(圆柱)]\n";
        assert_eq!(extract(DocKind::Flow, src).unwrap(), "节点：胶囊\n节点：六边形\n节点：平行\n节点：梯形\n节点：圆柱");
    }

    #[test]
    fn mind_quoted_text_and_spark_comments() {
        let src = "mindmap\n  %% spark: layout=balanced\n  [\"Rust (入门)\"]\n    %% spark: summary=1 bg=mint\n    [\"他说 #quot;好#quot;<br>第二行\"]\n";
        assert_eq!(extract(DocKind::Mind, src).unwrap(), "节点：Rust (入门)\n节点：他说 \"好\" 第二行");
    }

    #[test]
    fn keyword_words_as_node_ids_are_not_unsupported() {
        let src = "flowchart TD\n  start([开始]) --> end([结束])\n  end --> style\n  class --> style\n";
        assert_eq!(extract(DocKind::Flow, src).unwrap(), "节点：开始\n节点：结束\n节点：style\n节点：class");
        for bad in ["end", "subgraph A", "class A hot", "style A fill:#f96", "direction LR", "click A \"x\"", "linkStyle 0 stroke:red", "classDef hot fill:red"] {
            assert!(extract(DocKind::Flow, &format!("flowchart TD\n  A --> B\n  {bad}\n")).is_none(), "{bad}");
        }
    }

    #[test]
    fn flow_nodes_labels_and_unsupported() {
        let src = "graph TD\n  start(开始) --> test{测试通过？}\n  test -->|是| stage[\"部署 #quot;预发#quot;\"]; test -- 否 --> fix\n  fix -.-> start\n";
        assert_eq!(
            extract(DocKind::Flow, src).unwrap(),
            "节点：开始\n节点：测试通过？\n节点：部署 \"预发\"\n节点：fix\n连线：测试通过？ → 部署 \"预发\"（是）\n连线：测试通过？ → fix（否）"
        );
        assert!(extract(DocKind::Flow, "flowchart LR\n  subgraph 前端\n  end\n").is_none());
        assert!(extract(DocKind::Flow, "flowchart LR\n  A ---> B\n").is_none());
        assert!(extract(DocKind::Flow, "flowchart LR\n  A>x] --> B\n").is_none());
        assert!(extract(DocKind::Flow, "flowchart LR\n  A[[x]] --> B\n").is_none());
        assert!(extract(DocKind::Flow, "flowchart LR\n  A --> B & C\n").is_none());
        assert_eq!(extract(DocKind::Flow, "flowchart LR\n  A --> oB\n").unwrap(), "节点：A\n节点：oB");
    }
}
