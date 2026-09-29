//! 笔记库里 Spark 认识的三种文件：笔记 `.md`、思维导图 `.mind.mmd`、流程图 `.flow.mmd`。
//! 扩展名不区分大小写；显示名称时去掉整个扩展名。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Note,
    Mind,
    Flow,
}

impl DocKind {
    pub fn ext(self) -> &'static str {
        match self {
            DocKind::Note => ".md",
            DocKind::Mind => ".mind.mmd",
            DocKind::Flow => ".flow.mmd",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            DocKind::Note => "笔记",
            DocKind::Mind => "思维导图",
            DocKind::Flow => "流程图",
        }
    }

    /// 前端传来的类型名：`note`、`mind`、`flow`
    pub fn parse(name: &str) -> Result<DocKind, String> {
        match name {
            "note" => Ok(DocKind::Note),
            "mind" => Ok(DocKind::Mind),
            "flow" => Ok(DocKind::Flow),
            _ => Err(format!("未知的文件类型：{name}")),
        }
    }
}

/// 拆成“去掉扩展名的部分”和类型，如 `工作/上线.flow.mmd` → (`工作/上线`, Flow)；不认识的文件返回 None
pub fn split(path: &str) -> Option<(&str, DocKind)> {
    // 只转换 ASCII，字节位置不变，可以直接按长度切原字符串
    let lower = path.to_ascii_lowercase();
    for kind in [DocKind::Mind, DocKind::Flow, DocKind::Note] {
        let ext = kind.ext();
        if lower.len() > ext.len() && lower.ends_with(ext) {
            let stem = &path[..path.len() - ext.len()];
            if !stem.ends_with(['/', '\\']) {
                return Some((stem, kind));
            }
        }
    }
    None
}

pub fn kind_of(path: &str) -> Option<DocKind> {
    split(path).map(|(_, k)| k)
}

pub fn is_doc(path: &str) -> bool {
    split(path).is_some()
}

/// 文件名去掉扩展名，如 `工作/上线.flow.mmd` → `上线`；不认识的文件返回完整文件名
pub fn display_name(path: &str) -> &str {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    split(file).map(|(stem, _)| stem).unwrap_or(file)
}

/// 路径去掉扩展名，如 `工作/上线.flow.mmd` → `工作/上线`；不认识的文件原样返回
pub fn strip_ext(path: &str) -> &str {
    split(path).map(|(stem, _)| stem).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_three_kinds_case_insensitively() {
        assert_eq!(split("工作/周报.md"), Some(("工作/周报", DocKind::Note)));
        assert_eq!(split("a.MD"), Some(("a", DocKind::Note)));
        assert_eq!(split("工作/上线流程.flow.mmd"), Some(("工作/上线流程", DocKind::Flow)));
        assert_eq!(split("路线.Mind.MMD"), Some(("路线", DocKind::Mind)));
        assert_eq!(split("x.mind.md"), Some(("x.mind", DocKind::Note)));
        assert_eq!(split("x.mmd"), None);
        assert_eq!(split("readme.txt"), None);
        assert_eq!(split(".md"), None);
        assert_eq!(split("d/.flow.mmd"), None);
    }

    #[test]
    fn names_without_extension() {
        assert_eq!(display_name("工作/上线流程.flow.mmd"), "上线流程");
        assert_eq!(display_name("周报.md"), "周报");
        assert_eq!(display_name("d/img.png"), "img.png");
        assert_eq!(strip_ext("工作/读书 导图.mind.mmd"), "工作/读书 导图");
        assert_eq!(strip_ext("img.png"), "img.png");
    }
}
