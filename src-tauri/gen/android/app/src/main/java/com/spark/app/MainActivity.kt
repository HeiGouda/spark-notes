package com.spark.app

import android.graphics.Rect
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    PageTurn.attach(this, webView)
  }

  override fun onDestroy() {
    PageTurn.stop()
    super.onDestroy()
  }

  /** 阅读页的左右滑动翻页要在 WebView 之前拿到触摸（见 PageTurn） */
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean = PageTurn.dispatch(ev) { super.dispatchTouchEvent(it) }

  /*
   * 阅读页长按选字时，系统的复制、分享工具条和 App 自己的划线菜单会叠在一起。
   * WebView 每次选区变化都会重新往工具条里加菜单项，只在开始时清空不够，
   * 所以把它的回调包一层：每次准备菜单之后都清空，工具条没有内容就不显示，选区和把手照常保留。
   */
  override fun onWindowStartingActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
    if (!SecretPlugin.hideSelectionMenu || type != ActionMode.TYPE_FLOATING) {
      return super.onWindowStartingActionMode(callback, type)
    }
    return super.onWindowStartingActionMode(EmptyMenu(callback), type)
  }

  override fun onActionModeStarted(mode: ActionMode) {
    if (SecretPlugin.hideSelectionMenu && mode.type == ActionMode.TYPE_FLOATING) mode.menu.clear()
    super.onActionModeStarted(mode)
  }

  private class EmptyMenu(private val inner: ActionMode.Callback) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
      val ok = inner.onCreateActionMode(mode, menu)
      menu.clear()
      return ok
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
      inner.onPrepareActionMode(mode, menu)
      menu.clear()
      return true
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = inner.onActionItemClicked(mode, item)

    override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
      if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect) else super.onGetContentRect(mode, view, outRect)
    }
  }
}
