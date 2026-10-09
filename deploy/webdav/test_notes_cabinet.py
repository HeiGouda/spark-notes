"""笔记柜的路径、回收站和账号校验。不启动服务，也不调用 htpasswd。"""

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("notes_cabinet", HERE / "notes-cabinet.py")
cab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cab)


class CabinetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_libraries_and_loose(self) -> None:
        (self.root / "spark" / "工作").mkdir(parents=True)
        (self.root / "spark" / "生活").mkdir()
        (self.root / "spark" / "说明.txt").write_text("不是库", encoding="utf-8")
        (self.root / "spark" / ".hidden").mkdir()
        (self.root / "旧笔记.md").write_text("旧", encoding="utf-8")
        (self.root / ".secret").write_text("no", encoding="utf-8")
        (self.root / "spark-books").mkdir()
        (self.root / "spark-books" / "三体.epub").write_bytes(b"book")
        (self.root / "spark-books" / ".spark" / "progress.json").parent.mkdir()
        (self.root / "spark-books" / ".spark" / "progress.json").write_text("{}", encoding="utf-8")
        self.assertEqual(cab.libraries(self.root), ["工作", "生活"])
        self.assertEqual([p.name for p in cab.loose_entries(self.root)], ["旧笔记.md"])
        self.assertEqual([p.name for p in cab.shelf_books(self.root)], ["三体.epub"])
        self.assertIn("三体.epub", cab.shelf_main(self.root, "token"))

    def test_shelf_upload_rename_and_trash(self) -> None:
        (self.root / "spark" / "工作").mkdir(parents=True)
        saved = cab.store_shelf_book(self.root, "三体.epub", b"one")
        self.assertEqual(saved.name, "三体.epub")
        again = cab.store_shelf_book(self.root, "三体.epub", b"two", "rename")
        self.assertEqual(again.name, "三体 (2).epub")
        cab.store_shelf_book(self.root, "三体.epub", b"three", "overwrite")
        self.assertEqual((self.root / "spark-books" / "三体.epub").read_bytes(), b"three")
        self.assertTrue(list((self.root / "spark-books" / ".spark-trash").rglob("三体.epub")))
        with self.assertRaises(PermissionError):
            cab.store_shelf_book(self.root, "图片.png", b"no")
        cab.shelf_trash_book(self.root, "三体 (2).epub")
        self.assertFalse((self.root / "spark-books" / "三体 (2).epub").exists())
        with self.assertRaises(PermissionError):
            cab.loose_target(self.root, "spark")
        with self.assertRaises(PermissionError):
            cab.loose_target(self.root, "../spark")

    def test_shelf_check_tells_clash_and_alt_name(self) -> None:
        free = cab.check_shelf_name(self.root, "三体.epub")
        self.assertEqual(free, {"name": "三体.epub", "exists": False, "alt": "三体.epub"})
        cab.store_shelf_book(self.root, "三体.epub", b"one")
        cab.store_shelf_book(self.root, "三体.epub", b"two", "rename")
        taken = cab.check_shelf_name(self.root, "三体.epub")
        self.assertTrue(taken["exists"])
        self.assertEqual(taken["alt"], "三体 (3).epub")
        # 路径只取文件名，格式不对的不接受
        self.assertEqual(cab.check_shelf_name(self.root, "a/b/三体.epub")["name"], "三体.epub")
        with self.assertRaises(PermissionError):
            cab.check_shelf_name(self.root, "图片.png")
        with self.assertRaises(PermissionError):
            cab.check_shelf_name(self.root, ".hidden.epub")

    def test_shelf_page_follows_prototype(self) -> None:
        cab.store_shelf_book(self.root, "三体.epub", b"x" * 2048)
        page = cab.shelf_main(self.root, "tok")
        for text in ("上传书", "书名", "格式", "大小", "上传时间", "下载", "移入回收站", "EPUB", "单个文件不超过 300MB"):
            self.assertIn(text, page)
        # 可以一次选多个文件；上传脚本单独提供，不能写成内联脚本
        self.assertIn("multiple", page)
        self.assertIn(f"src='{cab.SHELF_JS_PATH}'", page)
        self.assertNotIn("<script>", page)
        self.assertIn("xhr.upload.onprogress", cab.SHELF_JS)
        self.assertIn("书架里已经有", cab.SHELF_JS)

    def test_upload_time_is_month_day_clock(self) -> None:
        path = self.root / "a.txt"
        path.write_text("x", encoding="utf-8")
        stamp = datetime(2026, 10, 2, 20, 11).timestamp()
        os.utime(path, (stamp, stamp))
        self.assertEqual(cab.upload_time(path), "10月2日 20:11")

    def test_child_rejects_dot_and_parent(self) -> None:
        lib = self.root / "spark" / "工作"
        lib.mkdir(parents=True)
        (lib / ".spark-trash").mkdir()
        with self.assertRaises(PermissionError):
            cab.child_in(lib, ".spark-trash")
        with self.assertRaises(PermissionError):
            cab.child_in(lib, "../生活")

    def test_trash_move_restore_and_conflict(self) -> None:
        lib = self.root / "spark" / "工作"
        (lib / "设计").mkdir(parents=True)
        note = lib / "设计" / "旧.md"
        note.write_text("正文", encoding="utf-8")
        when = cab.datetime(2026, 9, 18, 15, 30, 0)
        cab.move_to_trash(lib, note, when)
        self.assertFalse(note.exists())
        items = cab.trash_items(lib)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].rel, "设计/旧.md")
        (lib / "设计" / "旧.md").write_text("新的", encoding="utf-8")
        dest = cab.restore_item(lib, items[0])
        self.assertEqual(dest.name, "旧 (恢复).md")
        self.assertEqual(dest.read_text(encoding="utf-8"), "正文")
        self.assertEqual((lib / "设计" / "旧.md").read_text(encoding="utf-8"), "新的")
        self.assertEqual(cab.trash_items(lib), [])

    def test_prune_uses_retention_and_keeps_boundary(self) -> None:
        lib = self.root / "spark" / "工作"
        cfg = lib / ".ttnote" / "config"
        cfg.mkdir(parents=True)
        (cfg / "retention.json").write_text(json.dumps({"trashDays": 2}), encoding="utf-8")
        self.assertEqual(cab.trash_days(lib), 2)
        old = lib / ".spark-trash" / "2026-09-01" / "120000"
        old.mkdir(parents=True)
        (old / "过期.md").write_text("x", encoding="utf-8")
        edge = lib / ".spark-trash" / "2026-09-28" / "120000"
        edge.mkdir(parents=True)
        (edge / "边界.md").write_text("y", encoding="utf-8")
        cab.prune_trash(lib, 2, date(2026, 9, 30))
        self.assertFalse((lib / ".spark-trash" / "2026-09-01").exists())
        self.assertTrue((lib / ".spark-trash" / "2026-09-28" / "120000" / "边界.md").exists())
        label, soon = cab.left_label(2, date(2026, 9, 28), date(2026, 9, 30))
        self.assertEqual(label, "即将清理")
        self.assertTrue(soon)
        cab.prune_trash(lib, 0, date(2026, 9, 30))
        self.assertTrue((edge / "边界.md").exists())

    def test_root_is_the_library_until_spark_exists(self) -> None:
        folder = self.root / "课程"
        folder.mkdir()
        note = folder / "第一章.md"
        note.write_text("正文", encoding="utf-8")
        self.assertEqual(cab.shown_libraries(self.root), ["."])
        self.assertEqual(cab.loose_entries(self.root), [])
        lib = cab.library_dir(self.root, ".")
        cab.move_to_trash(lib, note)
        items = cab.trash_items(lib)
        self.assertEqual([item.rel for item in items], ["课程/第一章.md"])
        self.assertEqual(cab.lib_label(".")[0], "笔记库")

    def test_sort_matches_pc_custom_order(self) -> None:
        base = self.root / "lib"
        base.mkdir()
        for name in ["随手记.md", "产品规划.md", "笔记10.md", "笔记2.md", "a.md"]:
            (base / name).write_text("x", encoding="utf-8")
        (base / "读书").mkdir()
        (base / "工作").mkdir()
        order = {"": ["随手记.md", "读书", "产品规划.md"]}
        got = [p.name for p in cab.sort_children(list(base.iterdir()), "", order)]
        self.assertEqual(got, ["读书", "工作", "随手记.md", "产品规划.md", "a.md", "笔记2.md", "笔记10.md"])

    def test_chinese_numerals_sort_by_value(self) -> None:
        self.assertEqual([cab.cn_number(t) for t in ["十二", "二十", "一百零五", "二〇二六", "一万二千"]], ["12", "20", "105", "2026", "12000"])
        base = self.root / "lib"
        base.mkdir()
        for name in ["第二讲.md", "第十讲.md", "第一讲.md", "第五讲.md"]:
            (base / name).write_text("x", encoding="utf-8")
        got = [p.name for p in cab.sort_children(list(base.iterdir()), "", {}, ("name", False))]
        self.assertEqual(got, ["第一讲.md", "第二讲.md", "第五讲.md", "第十讲.md"])

    def test_sort_follows_pc_sort_and_recorded_times(self) -> None:
        base = self.root / "lib"
        config = base / ".ttnote" / "config"
        config.mkdir(parents=True)
        (base / "d").mkdir()
        for name in ["a.md", "b.md", "d/c.md"]:
            (base / name).write_text("x", encoding="utf-8")
        (config / "sort.json").write_text('{"key": "modified", "desc": true}', encoding="utf-8")
        (config / "times.json").write_text(
            "{\n"
            '  "a.md": {"created": 1, "modified": 50},\n'
            "<<<<<<< HEAD\n"
            '  "b.md": {"created": 2, "modified": 10},\n'
            "=======\n"
            '  "b.md": {"created": 3, "modified": 90},\n'
            ">>>>>>> theirs\n"
            '  "d": {"created": 1, "modified": 1},\n'
            '  "d/c.md": {"created": 5, "modified": 70}\n'
            "}\n",
            encoding="utf-8",
        )
        times = cab.load_times(base)
        self.assertEqual(times["b.md"], (2, 90))
        self.assertEqual(cab.load_sort(base), ("modified", True))
        self.assertEqual(cab.entry_times(base / "d", "d", times), (1, 70))
        got = [p.name for p in cab.sort_children([base / "a.md", base / "b.md", base / "d"], "", {}, cab.load_sort(base), times)]
        self.assertEqual(got, ["d", "b.md", "a.md"])
        self.assertEqual(cab.load_sort(self.root), cab.DEFAULT_SORT)

    def test_account_rules(self) -> None:
        existing = ["me", "phone"]
        self.assertEqual(cab.account_add_error("me", "a", "a", existing), "已经有这个用户名")
        self.assertEqual(cab.account_add_error("a b", "a", "a", existing), "用户名不能有空格或冒号")
        self.assertEqual(cab.account_add_error("pad", "a", "b", existing), "两次密码不一致")
        self.assertEqual(cab.account_add_error("pad", "a", "a", existing), "")
        self.assertEqual(cab.account_pass_error("me", "me", "", "a", "a", existing, False), "请填写当前密码")
        self.assertEqual(cab.account_pass_error("me", "me", "nope", "a", "a", existing, False), "当前密码不正确")
        self.assertEqual(cab.account_pass_error("phone", "me", "", "a", "a", existing, False), "")
        self.assertIn("正在登录", cab.account_drop_error("me", "me", existing))
        self.assertIn("最后一个", cab.account_drop_error("only", "ghost", ["only"]))
        self.assertEqual(cab.account_drop_error("phone", "me", existing), "")

    def test_passwd_path_matches_deploy(self) -> None:
        conf = (HERE / "webdav.conf").read_text(encoding="utf-8")
        install = (HERE / "install.sh").read_text(encoding="utf-8")
        self.assertIn(f"AuthUserFile {cab.PASSWD}", conf)
        self.assertIn(cab.PASSWD, install)
        self.assertNotIn("AuthUserFile /etc/apache2/webdav.passwd", conf)


if __name__ == "__main__":
    unittest.main()
