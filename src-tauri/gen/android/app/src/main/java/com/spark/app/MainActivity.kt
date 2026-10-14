package com.spark.app

import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.view.menu.MenuBuilder

class MainActivity : TauriActivity() {
  private var nativePages: NativePages? = null
  /** 系统的两个参数实现会再调回一个参数的版本，这里挡住，避免选字时栈溢出 */
  private var actionModeGuard = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    PageTurn.attach(this, webView)
    val pages = NativePages(this)
    pages.bind(webView)
    nativePages = pages
    webView.addJavascriptInterface(pages.bridge(), "NativePages")
    val pdf = PdfTiles(this)
    pdf.bind(webView)
    webView.addJavascriptInterface(pdf.bridge(), "PdfTiles")
    webView.post {
      val parent = webView.parent as? android.view.ViewGroup ?: return@post
      if (pages.parent == null) {
        parent.addView(pages, android.view.ViewGroup.LayoutParams(0, 0))
        pages.visibility = View.GONE
      }
      if (pdf.parent == null) {
        parent.addView(pdf, android.view.ViewGroup.LayoutParams(0, 0))
        pdf.visibility = View.GONE
      }
    }
    webView.setOnCreateContextMenuListener { menu, _, _ ->
      if (!SecretPlugin.hideSelectionMenu) return@setOnCreateContextMenuListener
      try {
        menu.clear()
      } catch (_: Throwable) {
        // 系统菜单还没建好时清空会抛
      }
    }
  }

  override fun onDestroy() {
    nativePages?.bridge()?.clear()
    PageTurn.stop()
    super.onDestroy()
  }

  /** 阅读页的左右滑动翻页要在 WebView 之前拿到触摸（见 PageTurn） */
  override fun dispatchTouchEvent(ev: MotionEvent): Boolean = PageTurn.dispatch(ev) { super.dispatchTouchEvent(it) }

  /*
   * 阅读页长按选字时，系统会给 WebView 拉起复制、分享工具条。
   * 一个参数的版本如果再去调两个参数的版本，系统又会调回来，选字直接栈溢出。
   * 所以这里直接返回。阅读页自己建浮动选区（两端把手靠它），并藏起复制、分享。
   */
  override fun onWindowStartingActionMode(callback: ActionMode.Callback): ActionMode? = null

  override fun onWindowStartingActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
    if (actionModeGuard || !SecretPlugin.hideSelectionMenu) return null
    actionModeGuard = true
    try {
      // 阅读页自己画选区和菜单。系统的浮动工具条会再弹出一个，这里只占住回调。
      return SelectionMode(callback)
    } finally {
      actionModeGuard = false
    }
  }

  override fun onActionModeStarted(mode: ActionMode) {
    if (SecretPlugin.hideSelectionMenu) hideSelectionItems(mode.menu)
    super.onActionModeStarted(mode)
  }

  private fun hideSelectionItems(menu: Menu?) {
    if (menu == null) return
    for (i in 0 until menu.size()) menu.getItem(i)?.isVisible = false
  }

  /**
   * 占住系统选区，不显示复制、分享。
   * 结束时通知 WebView，下一次选字的两端把手才能重新出来。不要在创建时清空菜单，那会闪退。
   */
  private inner class SelectionMode(private val callback: ActionMode.Callback) : ActionMode() {
    private val menu = MenuBuilder(this@MainActivity)
    private var closed = false

    override fun setTitle(title: CharSequence?) {}
    override fun setTitle(resId: Int) {}
    override fun setSubtitle(subtitle: CharSequence?) {}
    override fun setSubtitle(resId: Int) {}
    override fun setTitleOptionalHint(titleOptional: Boolean) {}
    override fun isTitleOptional(): Boolean = true
    override fun setCustomView(view: View?) {}
    override fun invalidate() {}
    override fun finish() {
      if (closed) return
      closed = true
      try {
        callback.onDestroyActionMode(this)
      } catch (_: Throwable) {
      }
    }
    override fun getMenu(): Menu = menu
    override fun getTitle(): CharSequence? = null
    override fun getSubtitle(): CharSequence? = null
    override fun getCustomView(): View? = null
    override fun getMenuInflater() = this@MainActivity.menuInflater
    override fun getType(): Int = TYPE_FLOATING
  }
}
