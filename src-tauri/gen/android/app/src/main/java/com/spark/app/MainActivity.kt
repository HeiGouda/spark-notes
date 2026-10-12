package com.spark.app

import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.view.menu.MenuBuilder

class MainActivity : TauriActivity() {
  private var readerWeb: WebView? = null
  /** 系统的两个参数实现会再调回一个参数的版本，这里挡住，避免选字时栈溢出 */
  private var actionModeGuard = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    readerWeb = webView
    PageTurn.attach(this, webView)
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
      return floatingSelection(callback) ?: SelectionMode(callback)
    } finally {
      actionModeGuard = false
    }
  }

  /**
   * 这台机上 FloatingActionMode 的构造方法和公开签名对不上，反射会失败。
   * 失败后如果返回 null，系统会自己弹出复制、分享。改由 [SelectionMode] 占住，系统就不再建那一套。
   */
  private fun floatingSelection(callback: ActionMode.Callback): ActionMode? {
    val origin = readerWeb ?: return null
    val parent = window?.decorView ?: return null
    val cls = try {
      Class.forName("com.android.internal.view.FloatingActionMode")
    } catch (_: Throwable) {
      return null
    }
    val wrapped = HiddenMenuCallback(callback)
    for (ctor in cls.declaredConstructors) {
      val types = ctor.parameterTypes
      ctor.isAccessible = true
      val args = arrayOfNulls<Any>(types.size)
      var views = 0
      var supported = true
      for (i in types.indices) {
        val p = types[i]
        args[i] = when {
          Context::class.java.isAssignableFrom(p) -> this
          ActionMode.Callback::class.java.isAssignableFrom(p) -> wrapped
          p == java.lang.Boolean.TYPE -> false
          p == Integer.TYPE -> typeFloating
          View::class.java.isAssignableFrom(p) -> if (views++ == 0) origin else parent
          else -> {
            supported = false
            null
          }
        }
        if (!supported) break
      }
      if (!supported) continue
      try {
        return ctor.newInstance(*args) as ActionMode
      } catch (_: Throwable) {
      }
    }
    return null
  }

  private val typeFloating = ActionMode.TYPE_FLOATING

  override fun onActionModeStarted(mode: ActionMode) {
    if (SecretPlugin.hideSelectionMenu) hideSelectionItems(mode.menu)
    super.onActionModeStarted(mode)
  }

  private fun hideSelectionItems(menu: Menu?) {
    if (menu == null) return
    for (i in 0 until menu.size()) menu.getItem(i)?.isVisible = false
  }

  /** 交给系统创建真正的选区模式（两端把手靠它），但不要显示复制、分享 */
  private inner class HiddenMenuCallback(private val inner: ActionMode.Callback) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean = inner.onCreateActionMode(mode, menu)

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
      inner.onPrepareActionMode(mode, menu)
      if (SecretPlugin.hideSelectionMenu) hideSelectionItems(menu)
      return true
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = false

    override fun onDestroyActionMode(mode: ActionMode) {
      inner.onDestroyActionMode(mode)
    }

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
      val cb = inner
      if (cb is ActionMode.Callback2) cb.onGetContentRect(mode, view, outRect)
    }
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
