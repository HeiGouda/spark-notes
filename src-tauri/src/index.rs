//! 搜索索引：`.ttnote/cache/index.db`（SQLite FTS5）。它只是缓存，删掉会自动重建，不参与同步。

#[cfg(test)]
use crate::notes::resolve_link;
use crate::notes::{map_wikilinks, parse, parse_query, snippet, tokenize, LinkIndex, Segment};
use crate::vault::{atomic_write, rel_of};
use rusqlite::{params, Connection};
#[cfg(test)]
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 2：fts 的 rowid 与 notes 的 rowid 一致，删除时按 rowid 定位
const SCHEMA_VERSION: i32 = 2;

fn db_err(e: rusqlite::Error) -> String {
    format!("搜索索引出错：{e}")
}

pub fn open(root: &Path) -> Result<Connection, String> {
    let dir = root.join(".ttnote").join("cache");
    fs::create_dir_all(&dir).map_err(|e| format!("创建索引目录失败 {}：{e}", dir.display()))?;
    let path = dir.join("index.db");
    open_at(&path).or_else(|_| {
        // 损坏通常在第一次读写时才暴露；索引只是缓存，删掉（连同 WAL 文件）重建
        for name in ["index.db", "index.db-wal", "index.db-shm"] {
            let _ = fs::remove_file(dir.join(name));
        }
        open_at(&path)
    })
}

fn open_at(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(db_err)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").map_err(db_err)?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
    if version != SCHEMA_VERSION {
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS links;
             CREATE TABLE notes(path TEXT PRIMARY KEY, title TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, body TEXT NOT NULL);
             CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body, tags, tokenize='unicode61 remove_diacritics 2');
             CREATE TABLE tags(path TEXT NOT NULL, tag TEXT NOT NULL);
             CREATE INDEX tags_tag ON tags(tag COLLATE NOCASE);
             CREATE INDEX tags_path ON tags(path);
             CREATE TABLE links(src TEXT NOT NULL, raw TEXT NOT NULL, target TEXT NOT NULL, base TEXT NOT NULL, line TEXT NOT NULL);
             CREATE INDEX links_base ON links(base);
             CREATE INDEX links_src ON links(src);
             PRAGMA user_version = {SCHEMA_VERSION};"
        ))
        .map_err(db_err)?;
    }
    Ok(conn)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        if name.starts_with('.') || (ft.is_dir() && name.ends_with(".assets")) {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            walk(root, &path, out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".md") {
            if let Ok(rel) = rel_of(root, &path) {
                out.push((rel, path));
            }
        }
    }
}

fn stem(rel: &str) -> String {
    let file = rel.rsplit('/').next().unwrap_or(rel);
    file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD")).unwrap_or(file).to_string()
}

fn index_one(conn: &Connection, rel: &str, content: &str, mtime: i64, size: i64) -> rusqlite::Result<()> {
    remove_one(conn, rel)?;
    let parsed = parse(content);
    let title = stem(rel);
    conn.execute(
        "INSERT INTO notes(path, title, mtime, size, body) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rel, title, mtime, size, parsed.body],
    )?;
    conn.execute(
        "INSERT INTO fts(rowid, path, title, body, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conn.last_insert_rowid(), rel, tokenize(&title), tokenize(&parsed.body), tokenize(&parsed.tags.join(" "))],
    )?;
    for tag in &parsed.tags {
        conn.execute("INSERT INTO tags(path, tag) VALUES (?1, ?2)", params![rel, tag])?;
    }
    for link in &parsed.links {
        let base = link.target.replace('\\', "/");
        let base = base.rsplit('/').next().unwrap_or(&base);
        let base = base.strip_suffix(".md").unwrap_or(base).to_lowercase();
        conn.execute(
            "INSERT INTO links(src, raw, target, base, line) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![rel, link.raw, link.target, base, link.line],
        )?;
    }
    Ok(())
}

fn remove_one(conn: &Connection, rel: &str) -> rusqlite::Result<()> {
    // fts 的 path 列不建索引，按 path 删除要扫全表；按 rowid 删除只需一次主键查找
    conn.execute("DELETE FROM fts WHERE rowid = (SELECT rowid FROM notes WHERE path = ?1)", [rel])?;
    conn.execute("DELETE FROM notes WHERE path = ?1", [rel])?;
    conn.execute("DELETE FROM tags WHERE path = ?1", [rel])?;
    conn.execute("DELETE FROM links WHERE src = ?1", [rel])?;
    Ok(())
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct SyncStats {
    pub indexed: usize,
    pub removed: usize,
    pub total: usize,
}

/// 增量同步：按修改时间和大小找出新增、修改、删除的笔记
pub fn sync(conn: &mut Connection, root: &Path) -> Result<SyncStats, String> {
    if !root.is_dir() {
        return Err(format!("笔记库目录不存在：{}", root.display()));
    }
    let mut files = Vec::new();
    walk(root, root, &mut files);
    let known: HashMap<String, (i64, i64)> = {
        let mut stmt = conn.prepare("SELECT path, mtime, size FROM notes").map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    let tx = conn.transaction().map_err(db_err)?;
    let mut stats = SyncStats { total: files.len(), ..Default::default() };
    let mut present = HashSet::new();
    for (rel, path) in &files {
        present.insert(rel.clone());
        let Ok(meta) = fs::metadata(path) else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        if known.get(rel) == Some(&(mtime, size)) {
            continue;
        }
        // 无法按 UTF-8 读取的文件跳过，不中断整个同步
        let Ok(content) = fs::read_to_string(path) else { continue };
        index_one(&tx, rel, &content, mtime, size).map_err(db_err)?;
        stats.indexed += 1;
    }
    for rel in known.keys().filter(|k| !present.contains(*k)) {
        remove_one(&tx, rel).map_err(db_err)?;
        stats.removed += 1;
    }
    tx.commit().map_err(db_err)?;
    Ok(stats)
}

fn all_paths(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT path FROM notes").map_err(db_err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: Vec<Segment>,
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let q = parse_query(query);
    if q.fts.is_none() && q.tags.is_empty() && q.folders.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = String::from("SELECT n.path, n.title, n.body FROM notes n");
    let mut args: Vec<String> = Vec::new();
    let mut conds: Vec<String> = Vec::new();
    if let Some(m) = &q.fts {
        sql.push_str(" JOIN fts ON fts.rowid = n.rowid");
        args.push(m.clone());
        conds.push(format!("fts MATCH ?{}", args.len()));
    }
    for tag in &q.tags {
        args.push(tag.clone());
        let i = args.len();
        conds.push(format!(
            "n.path IN (SELECT path FROM tags WHERE tag = ?{i} COLLATE NOCASE OR tag LIKE ?{i} || '/%' COLLATE NOCASE)"
        ));
    }
    for dir in &q.folders {
        args.push(dir.clone());
        conds.push(format!("n.path LIKE ?{} || '/%'", args.len()));
    }
    sql.push_str(" WHERE ");
    sql.push_str(&conds.join(" AND "));
    sql.push_str(if q.fts.is_some() { " ORDER BY bm25(fts, 0.0, 10.0, 1.0, 5.0)" } else { " ORDER BY n.title" });
    args.push(limit.to_string());
    sql.push_str(&format!(" LIMIT ?{}", args.len()));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (path, title, body) = row.map_err(db_err)?;
        out.push(SearchHit { snippet: snippet(&body, &q.terms, 90), path, title });
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

pub fn tags(conn: &Connection) -> Result<Vec<TagCount>, String> {
    let mut stmt = conn
        .prepare("SELECT tag, COUNT(DISTINCT path) FROM tags GROUP BY tag COLLATE NOCASE ORDER BY tag COLLATE NOCASE")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok(TagCount { tag: r.get(0)?, count: r.get::<_, i64>(1)? as usize }))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

/// 带有该标签（含子标签，如 `工作` 包括 `工作/周报`）的笔记
pub fn tag_notes(conn: &Connection, tag: &str) -> Result<Vec<NoteRef>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT n.path, n.title FROM tags t JOIN notes n ON n.path = t.path
             WHERE t.tag = ?1 COLLATE NOCASE OR t.tag LIKE ?1 || '/%' COLLATE NOCASE ORDER BY n.title",
        )
        .map_err(db_err)?;
    let rows = stmt.query_map([tag], |r| Ok(NoteRef { path: r.get(0)?, title: r.get(1)? })).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

#[cfg(test)]
fn resolve(conn: &Connection, src: &str, target: &str) -> Result<Option<String>, String> {
    let all = all_paths(conn)?;
    Ok(resolve_link(target, src, &all).cloned())
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub line: String,
}

pub fn backlinks(conn: &Connection, path: &str) -> Result<Vec<Backlink>, String> {
    let all = all_paths(conn)?;
    let links = LinkIndex::new(&all);
    let base = stem(path).to_lowercase();
    let mut stmt = conn
        .prepare("SELECT l.src, n.title, l.target, l.line FROM links l JOIN notes n ON n.path = l.src WHERE l.base = ?1")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([&base], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
        .map_err(db_err)?;
    let mut out: Vec<Backlink> = Vec::new();
    for row in rows {
        let (src, title, target, line) = row.map_err(db_err)?;
        if src == path || links.resolve(&target, &src).map(String::as_str) != Some(path) {
            continue;
        }
        if !out.iter().any(|b| b.path == src && b.line == line) {
            out.push(Backlink { path: src, title, line });
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(out)
}

/// 笔记或文件夹从 `from` 改名 / 移动到 `to` 之后，改写所有指向其中笔记的链接。
/// 必须在索引更新之前调用（用改名前的索引判断链接原本指向哪篇笔记）。返回被改写的笔记（新路径）。
pub fn rewrite_links(conn: &Connection, root: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    let before = all_paths(conn)?;
    let within = |p: &str| p == from || p.starts_with(&format!("{from}/"));
    let map_path = |p: &str| if within(p) { format!("{to}{}", &p[from.len()..]) } else { p.to_string() };
    let moved: HashMap<String, String> = before.iter().filter(|p| within(p)).map(|p| (p.clone(), map_path(p))).collect();
    if moved.is_empty() {
        return Ok(Vec::new());
    }
    let after: Vec<String> = before.iter().map(|p| map_path(p)).collect();
    let before_links = LinkIndex::new(&before);
    let after_links = LinkIndex::new(&after);

    // 链接的 base 是目标的笔记名（小写），只有指向被移动笔记名字的链接才可能需要改写，其余笔记不必读取
    let moved_bases: HashSet<String> = moved
        .keys()
        .map(|p| {
            let s = stem(p).to_lowercase();
            s.strip_suffix(".md").map(str::to_string).unwrap_or(s)
        })
        .collect();
    let mut stmt = conn.prepare("SELECT DISTINCT src, base FROM links").map_err(db_err)?;
    let mut sources: BTreeSet<String> = BTreeSet::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(db_err)?;
    for row in rows {
        let (src, base) = row.map_err(db_err)?;
        if moved_bases.contains(base.strip_suffix(".md").unwrap_or(&base)) {
            sources.insert(src);
        }
    }

    let mut changed = Vec::new();
    for src in sources {
        let actual = map_path(&src);
        let file = root.join(Path::new(&actual));
        let Ok(content) = fs::read_to_string(&file) else { continue };
        let updated = map_wikilinks(&content, |inner| {
            if inner.contains('[') || inner.contains(']') || inner.contains('\n') {
                return None;
            }
            let split = inner.find(['#', '|']).unwrap_or(inner.len());
            let target = inner[..split].trim();
            let old = before_links.resolve(target, &src)?;
            let new_path = moved.get(old)?;
            let had_path = target.contains('/');
            let as_path = new_path.strip_suffix(".md").unwrap_or(new_path).to_string();
            let text = if had_path {
                as_path
            } else {
                // 只写名字仍能从新位置解析到目标时写名字，否则写路径
                let name = as_path.rsplit('/').next().unwrap_or(&as_path).to_string();
                if after_links.resolve(&name, &actual).map(String::as_str) == Some(new_path.as_str()) {
                    name
                } else {
                    as_path
                }
            };
            // 原来只写笔记名、移动后仍能正确解析时不改
            if !had_path && text.eq_ignore_ascii_case(target) {
                return None;
            }
            Some(format!("{text}{}", &inner[split..]))
        });
        if updated != content {
            atomic_write(&file, &updated)?;
            changed.push(actual);
        }
    }
    Ok(changed)
}

#[cfg(test)]
fn exists(conn: &Connection, path: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM notes WHERE path = ?1", [path], |_| Ok(()))
        .optional()
        .map(|r| r.is_some())
        .map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(root, "工作/WebDAV 同步设计.md", "---\ntags: [工作]\n---\n多台电脑之间保持笔记一致。服务器用坚果云 WebDAV。\n见 [[周报]]\n");
        touch(root, "工作/周报.md", "本周完成同步设计 #工作/周报\n");
        touch(root, "个人/周报.md", "个人的周报\n");
        touch(root, "读书.md", "参考 [[工作/周报#本周|周报]] 与 [[WebDAV 同步设计]]\n");
        touch(root, ".ttnote/config/x.md", "忽略");
        touch(root, "工作/WebDAV 同步设计.assets/x.md", "忽略");
        let mut conn = open(root).unwrap();
        let stats = sync(&mut conn, root).unwrap();
        assert_eq!(stats, SyncStats { indexed: 4, removed: 0, total: 4 });
        (tmp, conn)
    }

    #[test]
    fn search_chinese_bigram_and_filters() {
        let (_tmp, conn) = setup();
        let hits = search(&conn, "同步", 20).unwrap();
        let paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.contains(&"工作/WebDAV 同步设计.md"));
        assert!(paths.contains(&"工作/周报.md"));
        // 标题命中排在前面
        assert_eq!(paths[0], "工作/WebDAV 同步设计.md");
        assert_eq!(search(&conn, "坚果", 20).unwrap().len(), 1);
        assert_eq!(search(&conn, "webdav", 20).unwrap().len(), 2);
        assert_eq!(search(&conn, "电脑之间", 20).unwrap().len(), 1);
        assert!(search(&conn, "之电", 20).unwrap().is_empty());
        let tagged: Vec<_> = search(&conn, "#工作", 20).unwrap().into_iter().map(|h| h.path).collect();
        assert_eq!(tagged, vec!["工作/WebDAV 同步设计.md", "工作/周报.md"]);
        assert_eq!(search(&conn, "周报 path:个人", 20).unwrap().len(), 1);
        let hit = &search(&conn, "坚果云", 20).unwrap()[0];
        assert!(hit.snippet.iter().any(|s| s.hit && s.text == "坚果云"));
    }

    #[test]
    fn incremental_sync_detects_changes_and_deletes() {
        let (tmp, mut conn) = setup();
        let root = tmp.path();
        std::thread::sleep(std::time::Duration::from_millis(20));
        touch(root, "读书.md", "改过了 三体\n");
        fs::remove_file(root.join("个人/周报.md")).unwrap();
        let stats = sync(&mut conn, root).unwrap();
        assert_eq!(stats, SyncStats { indexed: 1, removed: 1, total: 3 });
        assert_eq!(search(&conn, "三体", 20).unwrap().len(), 1);
        assert!(!exists(&conn, "个人/周报.md").unwrap());
        // 修改和删除后，旧内容不能再被搜到
        assert!(search(&conn, "参考", 20).unwrap().is_empty());
        assert!(search(&conn, "个人的", 20).unwrap().is_empty());
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM fts", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 3);
    }

    #[test]
    fn corrupt_index_is_rebuilt() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(root, "a.md", "坚果云\n");
        touch(root, ".ttnote/cache/index.db", "这不是数据库，这不是数据库，这不是数据库，这不是数据库");
        let mut conn = open(root).unwrap();
        assert_eq!(sync(&mut conn, root).unwrap().indexed, 1);
        assert_eq!(search(&conn, "坚果", 20).unwrap().len(), 1);
    }

    #[test]
    fn tags_with_hierarchy() {
        let (_tmp, conn) = setup();
        let t = tags(&conn).unwrap();
        assert_eq!(t, vec![TagCount { tag: "工作".into(), count: 1 }, TagCount { tag: "工作/周报".into(), count: 1 }]);
        assert_eq!(tag_notes(&conn, "工作").unwrap().len(), 2);
    }

    #[test]
    fn backlinks_follow_resolution_rules() {
        let (_tmp, conn) = setup();
        let bl = backlinks(&conn, "工作/周报.md").unwrap();
        let srcs: Vec<_> = bl.iter().map(|b| b.path.as_str()).collect();
        assert_eq!(srcs, vec!["工作/WebDAV 同步设计.md", "读书.md"]);
        assert!(backlinks(&conn, "个人/周报.md").unwrap().is_empty());
        // 根目录下写 [[周报]]：两个同名笔记路径一样深，按路径排序取第一个
        assert_eq!(resolve(&conn, "读书.md", "周报").unwrap().as_deref(), Some("个人/周报.md"));
        assert_eq!(resolve(&conn, "工作/周报.md", "周报").unwrap().as_deref(), Some("工作/周报.md"));
    }

    #[test]
    fn rename_rewrites_links_keeping_heading_and_alias() {
        let (tmp, conn) = setup();
        let root = tmp.path();
        fs::rename(root.join("工作/周报.md"), root.join("工作/周总结.md")).unwrap();
        let changed = rewrite_links(&conn, root, "工作/周报.md", "工作/周总结.md").unwrap();
        assert_eq!(changed.len(), 2);
        assert_eq!(fs::read_to_string(root.join("读书.md")).unwrap(), "参考 [[工作/周总结#本周|周报]] 与 [[WebDAV 同步设计]]\n");
        assert!(fs::read_to_string(root.join("工作/WebDAV 同步设计.md")).unwrap().contains("见 [[周总结]]"));
    }

    #[test]
    fn folder_move_rewrites_path_links_only() {
        let (tmp, conn) = setup();
        let root = tmp.path();
        fs::rename(root.join("工作"), root.join("项目")).unwrap();
        let changed = rewrite_links(&conn, root, "工作", "项目").unwrap();
        assert_eq!(changed, vec!["读书.md"]);
        assert_eq!(fs::read_to_string(root.join("读书.md")).unwrap(), "参考 [[项目/周报#本周|周报]] 与 [[WebDAV 同步设计]]\n");
    }

    #[test]
    fn rename_leaves_links_inside_code_unchanged() {
        let (tmp, conn) = setup();
        let root = tmp.path();
        let path = root.join("读书.md");
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("```md\n[[工作/周报]]\n```\n`[[周报]]`\n");
        fs::write(&path, &text).unwrap();
        fs::rename(root.join("工作/周报.md"), root.join("工作/周总结.md")).unwrap();
        rewrite_links(&conn, root, "工作/周报.md", "工作/周总结.md").unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.contains("[[工作/周总结#本周|周报]]"));
        assert!(after.contains("```md\n[[工作/周报]]\n```"));
        assert!(after.contains("`[[周报]]`"));
    }
}
