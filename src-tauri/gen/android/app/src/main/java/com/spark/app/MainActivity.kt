package com.spark.app

import android.graphics.Rect
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.view.menu.MenuBuilder
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var nativePages: NativePages? = null
  /** 系统的两个参数实现会再调回一个参数的版本，这里挡住，避免选字时栈溢出 */
  private var actionModeGuard = false
  private var lastKbCss = -1

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 旧系统边到边经常报不出 IME inset。让窗口跟着键盘缩小，网页再用可视高度兜底
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    PageTurn.attach(this, webView)
    watchKeyboard(webView)
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

  /**
   * 把键盘高度交给网页（CSS 像素）。只读 inset，不加 padding，
   * 原生翻页层仍按网页给的框摆，不会被键盘顶歪。
   */
  private fun watchKeyboard(webView: WebView) {
    // 不能换成只读的监听就结束：WebView 自己还要这份 inset，安全区才会算对。先读键盘高度，再交回去
    lateinit var listener: View.OnApplyWindowInsetsListener
    listener = View.OnApplyWindowInsetsListener { v, insets ->
      val compat = WindowInsetsCompat.toWindowInsetsCompat(insets, v)
      sendKeyboard(webView, compat.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      v.setOnApplyWindowInsetsListener(null)
      val result = try {
        v.onApplyWindowInsets(insets)
      } finally {
        v.setOnApplyWindowInsetsListener(listener)
      }
      result
    }
    webView.setOnApplyWindowInsetsListener(listener)
    webView.viewTreeObserver.addOnGlobalLayoutListener {
      val ime = ViewCompat.getRootWindowInsets(webView)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
      sendKeyboard(webView, ime)
    }
    ViewCompat.requestApplyInsets(webView)
    // 第一下可能发生在页面脚本之前，过一会儿再报一次当前高度
    webView.postDelayed({
      lastKbCss = -1
      val ime = ViewCompat.getRootWindowInsets(webView)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
      sendKeyboard(webView, ime)
    }, 1200)
  }

  private fun sendKeyboard(webView: WebView, imePx: Int) {
    val density = resources.displayMetrics.density.coerceAtLeast(0.1f)
    val raw = if (imePx > 0) imePx else legacyImePx()
    val css = (raw / density).roundToInt().coerceAtLeast(0)
    if (css == lastKbCss) return
    lastKbCss = css
    try {
      webView.evaluateJavascript("window.__sparkKeyboard&&window.__sparkKeyboard($css)", null)
    } catch (_: Throwable) {
      // 页面还没就绪时调用会抛，下一轮布局再报
      lastKbCss = -1
    }
  }

  /** API 30 以下 IME inset 常是 0。可见区域比屏幕矮出来的那段，多半是键盘；导航条那一点不算 */
  private fun legacyImePx(): Int {
    val rect = Rect()
    window.decorView.getWindowVisibleDisplayFrame(rect)
    val overlap = (resources.displayMetrics.heightPixels - rect.bottom).coerceAtLeast(0)
    val bars = ViewCompat.getRootWindowInsets(window.decorView)?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
    val slop = (8f * resources.displayMetrics.density).roundToInt()
    if (overlap <= bars + slop) return 0
    return overlap
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
