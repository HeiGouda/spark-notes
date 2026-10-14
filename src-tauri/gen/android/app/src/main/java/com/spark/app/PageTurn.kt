package com.spark.app

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.PopupWindow
import kotlin.math.abs

/**
 * 阅读页左右翻页的动画。
 *
 * 书页在 WebView 里，换页（尤其是换章）要等网页排版，直接在网页里做动画会闪、会掉帧。所以翻页时用截图盖在 WebView
 * 上面，动画只移动截图，网页在下面换页，换好、画上屏、和截图一样了才拿掉截图，换页和换章的过程都不会露出来。
 *
 * 截图盖在 PopupWindow 里，才能在盖着的同时用 PixelCopy 去截下面的 WebView。这个窗口在阅读页里一直开着（没在翻页时
 * 是透明的），每次翻页临时开窗口，窗口还没上屏网页就已经换页了，新页会先闪一下。
 *
 * 跟手：书页停稳后网页调 prefetch，把当前页、前两页、后四页画成纹理（邻章由网页事先排好，再逐页显示出来截）。
 * 网页用 SparkPicture 同步版式代数。代数没变、邻页纹理也在时，手指一过滑动阈值就平移这两张纹理，按下时不再整屏比对。
 * 版式变了（字号、字体、边距、主题）就丢掉纹理。没有纹理时退回慢的做法：先盖上，等网页换好页、截到新页再动。
 *
 * 点两侧翻页：网页先调 start，盖好后自己换页，换好后调 ready。
 * 左右滑动：手指横向滑出去时把这次触摸从 WebView 拿过来（给它发 CANCEL）。有预截时松手翻过去才通过
 * window.__sparkTurn('jump', dir) 让网页换页，没翻过去网页根本不用动；没有预截时盖好就 jump，松手没翻过去再用
 * 'back' 换回来。正在翻页时不再跟手，松手仍按这一下补翻一页（'turn'）。动画还在播时又翻，立刻打断这一下，
 * 改播下一次。往已经到头的方向滑时只发 'edge'，由网页提示。
 *
 * 动画跟屏幕的刷新走，每一帧只改两层截图的位移和透明度。截图放进硬件层，翻页途中不重画、不改裁剪，
 * 也不申请新的大图，免得把帧率拖下来。
 */
object PageTurn {
  /**
   * PREFETCH 预截前后页；CAPTURING 截旧页；COVERED 旧页盖上了，等网页换页；PREPARING 网页换好了，等新页上屏、截新页；
   * CATCHUP 新页刚截好，画面追上手指；FOLLOW 跟着手指；ANIMATING 自己走完剩下的；LANDING 动画已经走完，等网页换好；
   * BACKING 没翻过去，等网页换回原来那页；REVEALING 最后一帧画好就拿掉截图
   */
  private enum class Phase { IDLE, PREFETCH, CAPTURING, COVERED, PREPARING, CATCHUP, FOLLOW, ANIMATING, LANDING, BACKING, REVEALING }

  private const val READY_TIMEOUT_MS = 15000L
  private const val PAINT_TIMEOUT_MS = 1800L
  /** 截图时最多等几帧网页画上屏 */
  private const val SETTLE_FRAMES = 8

  private val main = Handler(Looper.getMainLooper())
  private val slideEase: TimeInterpolator = PathInterpolator(0.25f, 0.46f, 0.45f, 0.94f)
  private val fadeEase: TimeInterpolator = PathInterpolator(0.33f, 0f, 0.2f, 1f)
  private val flingEase: TimeInterpolator = DecelerateInterpolator()

  private var activity: Activity? = null
  private var web: WebView? = null

  private var enabled = false
  /** 书页里有选区。由网页在 selectionchange 时同步过来，选字拖动不能当成翻页 */
  @Volatile private var textSelecting = false
  private var anim = "slide"
  private var canPrev = true
  private var canNext = true
  /** 页脚高度（dp）。截图和截图层都不包括页脚那一条，页脚在网页里直接跟着换页变 */
  private var footer = 0f

  private var phase = Phase.IDLE
  /** 每次盖上或收尾时加一，晚到的回调对不上就丢掉 */
  private var gen = 0
  private var layer: TurnLayer? = null
  private var popup: PopupWindow? = null
  /** 窗口刚打开，第一帧上屏要多等一会 */
  private var popupFresh = false
  /** 慢的做法里截的旧页、新页 */
  private var outgoing: Bitmap? = null
  private var incoming: Bitmap? = null
  /** 预截：当前页、往后四页、往回两页。连着翻时直接用这些图，不用等新的截图 */
  private var cacheCur: Bitmap? = null
  private var cacheNext: Bitmap? = null
  private var cacheNext2: Bitmap? = null
  private var cacheNext3: Bitmap? = null
  private var cacheNext4: Bitmap? = null
  private var cachePrev: Bitmap? = null
  private var cachePrev2: Bitmap? = null
  private var prefetchAbort = false
  /** 只用来和别的图比较、从不显示的截图，反复用 */
  private var scratch: Bitmap? = null
  /** 画过的截图，等截图层换成别的内容之后（下一次截图开始时）再回收 */
  private val retired = mutableListOf<Bitmap>()
  private var animator: ValueAnimator? = null
  private var catchUp: ValueAnimator? = null
  /** 翻页动画跟 Choreographer 走，才能吃满屏幕刷新率；ValueAnimator 在部分机型上会被压到更低的帧率 */
  private var motionToken = 0
  private var motionFrame: Choreographer.FrameCallback? = null
  /** 正在翻的这一页还没结束时又要翻：记下方向，这一页走到头就接着播，中间不把截图揭掉 */
  private var queuedDir = 0
  /** 下一页的图已经在手里，不用再整屏比对就能接着播 */
  private var chainTrust = false
  private var savedModeId = 0
  private var refreshRaised = false
  private var popupX = Int.MIN_VALUE
  private var popupY = Int.MIN_VALUE
  private var progress = 0f
  private var dir = 1
  private var fromDrag = false
  /** 这次翻页用的是预截的图 */
  private var fast = false
  /** 预截的新页：网页换好页后画面应该和它一样 */
  private var fastTarget: Bitmap? = null
  private var jumpSent = false
  private var landed = false
  private var landFailed = false
  /** 这次翻页网页确实换了页，收尾时预截的图就作废了 */
  private var pageChanged = false
  /** 正在翻页时又要翻：这一页收尾后再盖这一页 */
  private var pendingCover: (() -> Unit)? = null
  private var readyTimeout: Runnable? = null

  private var fingerDown = false
  /** 这次触摸可能是翻页的滑动：从按下起记速度，松手时没能接管也要补一次翻页 */
  private var candidate = false
  private var gestureVt: VelocityTracker? = null
  /** 滑出去时正忙（预截、上一页还在收尾），没能接管的那个方向；0 是没有 */
  private var missedDir = 0
  /** 松手时朝着动画终点的速度（像素/秒），越快动画走得越快 */
  private var releaseSpeed = 0f
  /** 没接管的快速滑动补的那次翻页按它的速度走 */
  private var queuedSpeed = 0f
  private var queuedAt = 0L
  /** 用预截的图翻完，网页换好的页和预截的一样 */
  private var landedSame = false
  /** 网页排版的代数。字号、字体、边距、主题一变就加一，翻页本身不加 */
  private var pageGen = 0
  /** 现有纹理是按哪一版排版截的；对不上 pageGen 就不能拿来跟手 */
  private var cacheGen = -1
  /** 翻页过程中版式变了，收尾时再丢纹理 */
  private var pictureStale = false
  /** 这一轮预截开始时的排版代数，截完时变过就整套作废 */
  private var prefetchEpoch = 0
  private var tracking = false
  private var hijacked = false
  private var edgeDrag = false
  private var dragDir = 1
  private var downX = 0f
  private var downY = 0f
  private var downTime = 0L
  private var fingerDx = 0f
  private var released = false
  private var completeOnRelease = false
  private var velocity: VelocityTracker? = null

  fun attach(activity: Activity, webView: WebView) {
    this.activity = activity
    web = webView
    webView.addJavascriptInterface(SelectingFlag(), "SparkSelecting")
    webView.addJavascriptInterface(PictureFlag(), "SparkPicture")
  }

  /** 网页排版变了。翻页过程中先记下来，这一下走完再丢纹理，避免把正在画的图回收掉 */
  private fun noteGeneration(value: Int) {
    if (value == pageGen) return
    pageGen = value
    if (phase == Phase.IDLE || phase == Phase.PREFETCH) {
      if (phase == Phase.PREFETCH) prefetchAbort = true
      dropCache()
      return
    }
    pictureStale = true
    cacheGen = -1
  }

  /** enabled 只管能不能用滑动翻页；正在进行的翻页不受影响 */
  fun configure(enabled: Boolean, anim: String, canPrev: Boolean, canNext: Boolean, footer: Float) {
    this.enabled = enabled
    this.anim = anim
    this.canPrev = canPrev
    this.canNext = canNext
    if (footer > 0f) this.footer = footer
    // 菜单、上下滚动时滑动是关的。预截还盖着旧的左右分页，下面的版式一变就会对不上
    if (!enabled && phase == Phase.PREFETCH) prefetchAbort = true
    if (phase == Phase.IDLE) openWindow()
    preferHighRefresh()
  }

  /** 阅读的时候用这块屏幕支持的最高刷新率，翻页动画才能跟上 */
  private fun preferHighRefresh() {
    if (refreshRaised) return
    val act = activity ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    try {
      val display: Display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        act.display ?: return
      } else {
        @Suppress("DEPRECATION")
        act.windowManager.defaultDisplay
      }
      val current = display.mode
      val best = display.supportedModes
        .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
        .maxByOrNull { it.refreshRate } ?: return
      if (best.modeId == current.modeId || best.refreshRate <= current.refreshRate + 0.5f) return
      val attrs = act.window.attributes
      savedModeId = attrs.preferredDisplayModeId
      attrs.preferredDisplayModeId = best.modeId
      act.window.attributes = attrs
      refreshRaised = true
    } catch (_: RuntimeException) {
      refreshRaised = false
    }
  }

  private fun restoreRefresh() {
    if (!refreshRaised) return
    refreshRaised = false
    val act = activity ?: return
    try {
      val attrs = act.window.attributes
      attrs.preferredDisplayModeId = savedModeId
      act.window.attributes = attrs
    } catch (_: RuntimeException) {
    }
  }

  /** 截图的高度：WebView 去掉底下的页脚 */
  private fun shotHeight(w: WebView): Int {
    val cut = (footer * w.resources.displayMetrics.density).toInt()
    return (w.height - cut).coerceAtLeast(1)
  }

  /** 离开阅读页：收掉截图和窗口，不再接管滑动 */
  fun stop() {
    restoreRefresh()
    enabled = false
    textSelecting = false
    tracking = false
    hijacked = false
    edgeDrag = false
    fingerDown = false
    velocity?.recycle()
    velocity = null
    pendingCover = null
    finish()
    dropCache()
    popup?.let { if (it.isShowing) it.dismiss() }
    popup = null
    (layer?.parent as? ViewGroup)?.removeView(layer)
    layer = null
    scratch = null
    retired.clear()
  }

  /** 点两侧翻页。done(true) 表示截图已经盖上，网页可以换页了；false 表示这次不做动画（正忙或截图失败） */
  fun start(dir: Int, done: (Boolean) -> Unit) {
    if (web == null || hijacked) return done(false)
    cover(dir, false, done)
  }

  /** 书页停稳了：盖上当前页，让网页依次显示后四页、前两页，各截一张，翻页时直接用 */
  fun prefetch() {
    val w = web ?: return
    if (phase != Phase.IDLE || hijacked || fingerDown || !enabled || anim == "none") return
    if (w.width <= 0 || w.height <= 0) return
    gen++
    val g = gen
    prefetchEpoch = pageGen
    phase = Phase.PREFETCH
    prefetchAbort = false
    recycleRetired()
    val cur = newShot() ?: return endPrefetch(g)
    copyWindow(cur) { s ->
      if (g != gen) {
        recycleIfLoose(s ?: cur)
        return@copyWindow
      }
      if (s == null) return@copyWindow endPrefetch(g)
      // 画面和已有的当前页一样（比如刚翻过来时用上一页的截图接上了），只补还没有的那一边
      val old = cacheCur
      val kept = old != null && !old.isRecycled && old.sameAs(s)
      val needNext = !kept || cacheNext == null
      val needNext2 = !kept || cacheNext2 == null
      val needNext3 = !kept || cacheNext3 == null
      val needNext4 = !kept || cacheNext4 == null
      val needPrev = !kept || cachePrev == null
      val needPrev2 = !kept || cachePrev2 == null
      if (kept) s.recycle() else dropCache()
      if (!needNext && !needNext2 && !needNext3 && !needNext4 && !needPrev && !needPrev2) {
        if (prefetchEpoch == pageGen) cacheGen = pageGen
        return@copyWindow endPrefetch(g)
      }
      val shot = if (kept) old!! else s.also { prepare(it) }
      val l = showLayer(shot, null)
      if (l == null) {
        if (!kept) shot.recycle()
        return@copyWindow endPrefetch(g)
      }
      val steps = listOf(
        PeekStep(needNext, 1, 1),
        PeekStep(needNext2, 1, 2),
        PeekStep(needNext3, 1, 3),
        PeekStep(needNext4, 1, 4),
        // 往后几页换过去时，头一两帧可能还是后一页的画面，不能当成前一页
        PeekStep(needPrev, -1, 1),
        PeekStep(needPrev2, -1, 2),
      )
      afterLayerFrame(l) {
        afterPresented {
          if (g != gen) return@afterPresented
          peekAll(steps, shot, g) { shots ->
            if (g != gen) {
              shots.forEach { recycleIfLoose(it) }
              return@peekAll
            }
            web?.evaluateJavascript("window.__sparkUnpeek&&window.__sparkUnpeek()", null)
            settleTo(shot, g) { same ->
              if (g != gen) {
                shots.forEach { recycleIfLoose(it) }
                return@settleTo
              }
              if (same && prefetchEpoch == pageGen) {
                cacheCur = shot
                shots.getOrNull(0)?.let { cacheNext = it }
                shots.getOrNull(1)?.let { cacheNext2 = it }
                shots.getOrNull(2)?.let { cacheNext3 = it }
                shots.getOrNull(3)?.let { cacheNext4 = it }
                shots.getOrNull(4)?.let { cachePrev = it }
                shots.getOrNull(5)?.let { cachePrev2 = it }
                cacheGen = pageGen
              } else {
                // 截的时候书页变了（比如打开了菜单），这一套不能用
                if (kept) dropCache() else retire(shot)
                shots.forEach { recycleIfLoose(it) }
              }
              endPrefetch(g)
            }
          }
        }
      }
    }
  }

  private data class PeekStep(val need: Boolean, val dir: Int, val distance: Int)

  /** 按顺序截这几页。某一页不需要时跳过，已经截到的图传给下一步，避免把同一页再截一遍 */
  private fun peekAll(steps: List<PeekStep>, cur: Bitmap, g: Int, done: (List<Bitmap?>) -> Unit) {
    val shots = arrayOfNulls<Bitmap>(steps.size)
    fun run(i: Int, shown: Bitmap?) {
      if (g != gen) {
        shots.forEach { it?.recycle() }
        return
      }
      if (i == steps.size) {
        done(shots.toList())
        return
      }
      val step = steps[i]
      peekIf(step.need, step.dir, cur, shown, g, step.distance) { shot ->
        shots[i] = shot
        run(i + 1, shot ?: shown)
      }
    }
    run(0, null)
  }

  private fun peekIf(need: Boolean, d: Int, cur: Bitmap, shown: Bitmap?, g: Int, distance: Int = 1, done: (Bitmap?) -> Unit) {
    if (!need) return done(null)
    peekShot(d, cur, shown, g, done, distance)
  }

  private fun endPrefetch(g: Int) {
    if (g != gen) return
    layer?.setPages(null, null)
    phase = Phase.IDLE
    val next = pendingCover
    pendingCover = null
    if (next != null) main.post(next)
  }

  /**
   * 让网页显示 d 那一边的页面，截到它为止：和当前页、和上一步显示的画面 shown 都不一样，连着两帧不变。
   * 拿不到就是 null
   */
  private fun peekShot(d: Int, cur: Bitmap, shown: Bitmap?, g: Int, done: (Bitmap?) -> Unit, distance: Int = 1) {
    val w = web ?: return done(null)
    if (prefetchAbort) return done(null)
    val dist = distance.coerceAtLeast(1)
    w.evaluateJavascript("window.__sparkPeek ? window.__sparkPeek($d, $dist) : false") { result ->
      if (g != gen) return@evaluateJavascript
      if (result != "true" || prefetchAbort) return@evaluateJavascript done(null)
      settleNew(cur, g, true, shown, done)
    }
  }

  /** 网页换好页了；moved 为 false 表示没翻动（到头了或者出错），下面还是原来那一页 */
  fun ready(moved: Boolean) {
    if (fast) return landFast(moved)
    when (phase) {
      Phase.COVERED -> {}
      Phase.BACKING -> {
        clearReadyTimeout()
        if (!moved) return finish()
        val g = gen
        val old = outgoing ?: return finish()
        // 换回来的画面和旧页截图一样了才拿掉截图，不然会露出半截新页
        return settleTo(old, g) { if (g == gen) finish() }
      }
      else -> return
    }
    clearReadyTimeout()
    if (!moved) return finish()
    pageChanged = true
    if (fromDrag && released && !completeOnRelease) return goBack()
    phase = Phase.PREPARING
    val g = gen
    val old = outgoing ?: return finish()
    settleNew(old, g, false, null) { shot ->
      if (g != gen) return@settleNew
      val l = layer
      if (shot == null || l == null) return@settleNew finish()
      retire(incoming)
      incoming = shot
      l.setPages(old, shot)
      apply(progress)
      when {
        anim == "none" -> finish()
        !fromDrag -> playTurn(1f, takeQueuedSpeed()) { revealStable() }
        !released -> catchUpToFinger()
        else -> settleDrag()
      }
    }
  }

  /** 用预截的图翻页时网页换好了：确认画面和预截的新页一样，动画也走完了，就拿掉截图 */
  private fun landFast(moved: Boolean) {
    if (!jumpSent || landed) return
    clearReadyTimeout()
    if (!moved) {
      landFailed = true
      if (phase == Phase.LANDING) playTurn(0f) { finish() }
      return
    }
    pageChanged = true
    val g = gen
    val target = fastTarget ?: return finish()
    settleTo(target, g) { same ->
      if (g != gen) return@settleTo
      if (same) {
        landed = true
        landedSame = true
        if (phase == Phase.LANDING) revealStable()
        return@settleTo
      }
      // 换好的页和预截的不一样（预截之后书页又变过）：截下真正的新页，动画走完后淡过去，不硬切
      val actual = newShot() ?: run {
        landed = true
        if (phase == Phase.LANDING) revealStable()
        return@settleTo
      }
      copyWindow(actual) { s ->
        if (g != gen) {
          actual.recycle()
          return@copyWindow
        }
        if (s != null) {
          prepare(s)
          retire(incoming)
          incoming = s
          mismatch = s
        } else actual.recycle()
        landed = true
        if (phase == Phase.LANDING) revealStable()
      }
    }
  }

  /** 用预截的图翻完了，但网页换好的页和预截的不一样：从预截的图淡到真正的新页 */
  private var mismatch: Bitmap? = null

  private fun motionDone() {
    if (tryChain()) return
    when {
      landFailed -> playTurn(0f) { finish() }
      landed -> revealStable()
      else -> phase = Phase.LANDING
    }
  }

  /**
   * 这一页的动画已经走到头，下一页的图也在手里：截图不揭掉，直接从这一页接着播下一页。
   * 往同一方向走用再下一页的预截；往回走用刚刚离开的那一页。
   */
  private fun tryChain(): Boolean {
    val next = pendingCover ?: return false
    if (anim == "none" || !fast || !cacheFresh()) return false
    val shown = fastTarget ?: return false
    if (shown.isRecycled) return false
    val going = if (queuedDir == 0) dir else queuedDir
    val neighbor = if (going == dir) {
      if (dir > 0) cacheNext2 else cachePrev2
    } else {
      cacheCur
    }
    if (neighbor == null || neighbor.isRecycled || neighbor === shown) return false
    if (cacheCur == null || cacheCur!!.isRecycled) return false
    pageChanged = true
    landed = true
    landedSame = true
    pendingCover = null
    queuedDir = 0
    chainTrust = true
    gen++
    stopMotion()
    seedCache()
    phase = Phase.IDLE
    next()
    return true
  }

  fun dispatch(ev: MotionEvent, pass: (MotionEvent) -> Boolean): Boolean {
    if (hijacked) {
      onDrag(ev)
      return true
    }
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        fingerDown = true
        missedDir = 0
        // 邻页纹理还没好才打断预截。已经能跟手时留着纹理，滑动直接用
        if (phase == Phase.PREFETCH && !cacheFresh()) prefetchAbort = true
        candidate = enabled && web != null
        tracking = candidate
        downX = ev.rawX
        downY = ev.rawY
        downTime = ev.eventTime
        gestureVt?.recycle()
        gestureVt = if (candidate) VelocityTracker.obtain().also { it.addMovement(ev) } else null
      }
      MotionEvent.ACTION_POINTER_DOWN -> {
        tracking = false
        candidate = false
      }
      MotionEvent.ACTION_MOVE -> {
        gestureVt?.addMovement(ev)
        if (tracking && tryHijack(ev, pass)) return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        gestureVt?.addMovement(ev)
        if (ev.actionMasked == MotionEvent.ACTION_UP && candidate && missedDir != 0) missedSwipe(ev)
        tracking = false
        candidate = false
        fingerDown = false
        gestureVt?.recycle()
        gestureVt = null
      }
    }
    return pass(ev)
  }

  /**
   * 滑出去时没能跟手。补一页动画。正在播的那页会被打断，马上改播这一下。
   */
  private fun missedSwipe(ev: MotionEvent) {
    val w = web ?: return
    val d = missedDir
    missedDir = 0
    if (textSelecting) return
    val density = w.resources.displayMetrics.density
    val vt = gestureVt
    vt?.computeCurrentVelocity(1000)
    val toward = -d * (vt?.xVelocity ?: 0f)
    val moved = -d * (ev.rawX - downX)
    if (moved < 30f * density && !(toward > 400f * density && moved > 16f * density)) return
    queuedSpeed = toward.coerceAtLeast(0f)
    queuedAt = ev.eventTime
    w.evaluateJavascript("window.__sparkTurn&&window.__sparkTurn('turn', $d)", null)
  }

  /** 补的那次翻页刚发出不久就用它的速度，过期就按点两侧的速度 */
  private fun takeQueuedSpeed(): Float {
    val s = queuedSpeed
    queuedSpeed = 0f
    return if (android.os.SystemClock.uptimeMillis() - queuedAt < 1500L) s else 0f
  }

  /** 纹理和当前 WebView 一样大，才能盖上去跟手 */
  private fun fits(b: Bitmap?): Boolean {
    val w = web ?: return false
    return b != null && !b.isRecycled && b.width == w.width && b.height == shotHeight(w)
  }

  /** 当前页纹理还是这一版排版截的 */
  private fun cacheFresh(): Boolean = cacheGen == pageGen && fits(cacheCur)

  /** 这一侧的邻页纹理能直接拿来翻 */
  private fun textureReady(d: Int): Boolean {
    if (cacheGen != pageGen) return false
    val neighbor = if (d > 0) cacheNext else cachePrev
    return fits(cacheCur) && fits(neighbor) && neighbor !== cacheCur
  }

  /**
   * 只有书页停稳，或预截还在进行但这一侧的纹理已经好了，才跟着手指。
   * 正在翻页时把新的滑动抢过来，这一下经常翻不成页，快滑好几次就只剩一页。
   * 忙的时候记下方向，松手再按一次滑动补翻。
   */
  private fun canHijack(): Boolean = pendingCover == null && phase == Phase.IDLE

  private fun tryHijack(ev: MotionEvent, pass: (MotionEvent) -> Boolean): Boolean {
    val w = web ?: return false
    val slop = ViewConfiguration.get(w.context).scaledTouchSlop
    val dx = ev.rawX - downX
    val dy = ev.rawY - downY
    // 已经在选字，或手指按住够久（长按选字），或竖向移动是在换行：这次触摸留给选字
    if (textSelecting || ev.eventTime - downTime > ViewConfiguration.getLongPressTimeout()) {
      tracking = false
      return false
    }
    if (abs(dy) > slop && abs(dy) > abs(dx) * 0.7f) {
      tracking = false
      return false
    }
    val density = w.resources.displayMetrics.density
    if (abs(dx) < 16f * density || abs(dx) < abs(dy) * 1.8f) return false
    if (!enabled) {
      tracking = false
      return false
    }
    val d = if (dx < 0) 1 else -1
    val edge = if (d > 0) !canNext else !canPrev
    // 预截进行中只要这一侧的纹理好了就立刻跟手，fastDrag 会把这一轮预截作废
    val takeover = phase == Phase.PREFETCH && !edge && textureReady(d)
    if (!takeover && !canHijack()) {
      missedDir = d
      // 预截时网页正停在旁边那一页，这次滑动不能再交给它
      if (phase == Phase.PREFETCH) return true
      return false
    }
    if (takeover) {
      prefetchAbort = true
      w.evaluateJavascript("window.__sparkUnpeek&&window.__sparkUnpeek()", null)
    }
    tracking = false
    missedDir = 0
    val cancel = MotionEvent.obtain(ev)
    cancel.action = MotionEvent.ACTION_CANCEL
    pass(cancel)
    cancel.recycle()
    hijacked = true
    dragDir = d
    fingerDx = dx
    released = false
    completeOnRelease = false
    // 从按下起的速度记录一起交过去，快速一甩也能算准松手的速度
    velocity = gestureVt ?: VelocityTracker.obtain().also { it.addMovement(ev) }
    gestureVt = null
    edgeDrag = edge
    if (edge) return true
    val neighbor = if (d > 0) cacheNext else cachePrev
    if (anim != "none" && neighbor != null && textureReady(d) && fastDrag(d, neighbor)) return true
    beginDrag(d)
    return true
  }

  /** 用预截的图：截图一盖上就跟着手指，网页先不动，松手翻过去了才换页 */
  private fun fastDrag(d: Int, neighbor: Bitmap): Boolean {
    val cur = cacheCur ?: return false
    gen++
    resetTurn(d, true)
    fast = true
    fastTarget = neighbor
    showLayer(cur, neighbor) ?: run {
      phase = Phase.IDLE
      return false
    }
    follow()
    return true
  }

  private fun beginDrag(d: Int) {
    cover(d, true) { ok ->
      if (!ok) return@cover
      if (released && !completeOnRelease) return@cover finish()
      callJs("jump", d)
    }
  }

  private fun onDrag(ev: MotionEvent) {
    velocity?.addMovement(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        fingerDx = ev.rawX - downX
        if (phase == Phase.FOLLOW && !edgeDrag) apply(fingerProgress())
      }
      MotionEvent.ACTION_UP -> release(false)
      MotionEvent.ACTION_CANCEL -> release(true)
    }
  }

  private fun fingerProgress(): Float {
    val width = (web?.width ?: 1).coerceAtLeast(1)
    return (-dragDir * fingerDx / width).coerceIn(0f, 1f)
  }

  private fun release(cancelled: Boolean) {
    hijacked = false
    fingerDown = false
    val vt = velocity
    velocity = null
    vt?.computeCurrentVelocity(1000)
    val vx = vt?.xVelocity ?: 0f
    vt?.recycle()
    val density = web?.resources?.displayMetrics?.density ?: 1f
    val fling = 400f * density
    val toward = -dragDir * vx
    val p = fingerProgress()
    completeOnRelease = !cancelled && toward > -fling && (p > 0.28f || (toward > fling && p > 0.02f))
    releaseSpeed = (if (completeOnRelease) toward else -toward).coerceAtLeast(0f)
    if (edgeDrag) {
      edgeDrag = false
      if (completeOnRelease) callJs("edge", dragDir)
      return
    }
    released = true
    // 新页还没截好时先记下松手的结果，截好后再走完或翻回去
    if (phase == Phase.FOLLOW || phase == Phase.CATCHUP) settleDrag()
  }

  private fun follow() {
    phase = Phase.FOLLOW
    apply(fingerProgress())
  }

  /** 新页截好时手指已经滑出去一段：画面很快追上手指，再跟着手指走 */
  private fun catchUpToFinger() {
    val from = progress
    if (abs(fingerProgress() - from) < 0.02f) return follow()
    phase = Phase.CATCHUP
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 120L
    a.interpolator = DecelerateInterpolator()
    a.addUpdateListener { apply(from + (fingerProgress() - from) * (it.animatedValue as Float)) }
    a.addListener(object : AnimatorListenerAdapter() {
      private var cancelled = false
      override fun onAnimationCancel(animation: Animator) {
        cancelled = true
      }

      override fun onAnimationEnd(animation: Animator) {
        if (catchUp === a) catchUp = null
        if (!cancelled && phase == Phase.CATCHUP) follow()
      }
    })
    catchUp = a
    a.start()
  }

  private fun settleDrag() {
    catchUp?.cancel()
    catchUp = null
    if (fast) {
      if (completeOnRelease) {
        jumpSent = true
        scheduleReadyTimeout()
        callJs("jump", dir)
        playTurn(1f, releaseSpeed) { motionDone() }
      } else {
        // 网页一直没动，截图回到原处就能拿掉
        playTurn(0f, releaseSpeed) { finish() }
      }
      return
    }
    if (completeOnRelease) playTurn(1f, releaseSpeed) { revealStable() }
    else playTurn(0f, releaseSpeed) { goBack() }
  }

  /** 最终那一帧画好了再拿掉截图，下面的网页已经是同一个画面 */
  private fun revealStable() {
    val l = layer ?: return finish()
    val seen = gen
    phase = Phase.REVEALING
    val real = mismatch
    val shown = fastTarget
    if (real != null && shown != null) {
      mismatch = null
      l.setPages(shown, real)
      val a = ValueAnimator.ofFloat(1f, 0f)
      a.duration = 120L
      a.addUpdateListener { l.place(0f, 0f, it.animatedValue as Float, false) }
      a.addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          if (gen == seen) afterLayerFrame(l) { if (gen == seen) finish() }
        }
      })
      animator = a
      a.start()
      return
    }
    apply(1f)
    afterLayerFrame(l) { if (gen == seen) finish() }
  }

  /**
   * 走完剩下的部分：点两侧从 0 走到 1；滑动松手后从手指的位置接着走，越走越慢。
   * speed 是松手时朝终点的速度（像素/秒）：手指甩得快，起步就和手指一样快，剩下的路也走得快
   */
  private fun playTurn(target: Float, speed: Float = 0f, then: () -> Unit) {
    val remaining = abs(target - progress)
    if (remaining < 0.01f) {
      apply(target)
      then()
      return
    }
    val w = web
    val width = (w?.width ?: 1).coerceAtLeast(1)
    val density = w?.resources?.displayMetrics?.density ?: 1f
    if (speed > 250f * density) {
      // 先快后慢的曲线起步斜率是 2：时长 = 2 × 剩下的距离 ÷ 速度，起步速度正好接上手指
      // 甩得越快，剩下的路越短。上限压低，下一页才能马上接上
      val duration = (2000f * remaining * width / speed).toLong().coerceIn(16L, 90L)
      animateTo(target, duration, flingEase, then)
      return
    }
    val ease = if (anim == "fade") fadeEase else slideEase
    animateTo(target, (240f * remaining).toLong().coerceIn(80L, 240L), ease, then)
  }

  /** 没翻过去：截图回到原处盖住，让网页翻回原来那一页 */
  private fun goBack() {
    stopMotion()
    catchUp?.cancel()
    catchUp = null
    val l = layer
    val old = outgoing
    if (l == null || old == null || web == null) return finish()
    l.setPages(old, null)
    progress = 0f
    apply(0f)
    // 翻回去以后还是原来那页
    pageChanged = false
    phase = Phase.BACKING
    scheduleReadyTimeout()
    callJs("back", dir)
  }

  private fun resetTurn(d: Int, drag: Boolean) {
    dir = d
    fromDrag = drag
    progress = 0f
    fast = false
    fastTarget = null
    jumpSent = false
    landed = false
    landFailed = false
    pageChanged = false
    mismatch = null
    landedSame = false
  }

  /** 动画已经在走，可以立刻掐掉改播下一次。手指还按着、或这一页的图都还没出来时不打断 */
  private fun canInterrupt(): Boolean =
    phase == Phase.ANIMATING || phase == Phase.LANDING || phase == Phase.REVEALING

  /** 正在进来的那一页。打断时把它当成已经翻到的页 */
  private fun committedBitmap(): Bitmap? {
    val shown = if (fast && fastTarget != null) fastTarget else incoming
    return if (shown != null && !shown.isRecycled) shown else null
  }

  /**
   * 打断正在播的动画，马上从这一页接着翻。
   * 同一方向用再下一页的图；反方向用刚刚离开的那一页。没有现成的图就先把这一页铺满，等网页换好再动。
   */
  private fun interrupt(d: Int, done: (Boolean) -> Unit) {
    val shown = committedBitmap()
    val canSeed = shown != null && (
      (fast && cacheCur != null && !cacheCur!!.isRecycled) ||
        (!fast && outgoing != null && !outgoing!!.isRecycled)
      )
    if (canSeed) {
      pageChanged = true
      landed = true
      landedSame = fast
    }
    pendingCover = null
    queuedDir = 0
    // 先作废旧回调再停动画，否则收尾会把新的这一下拆掉
    gen++
    stopMotion()
    catchUp?.cancel()
    catchUp = null
    if (canSeed) seedCache()
    phase = Phase.IDLE
    val neighbor = if (d > 0) cacheNext else cachePrev
    val cur = cacheCur
    if (anim != "none" && neighbor != null && cur != null && !neighbor.isRecycled && !cur.isRecycled && neighbor !== cur) {
      chainTrust = true
      cover(d, false, done)
      return
    }
    val held = if (shown != null && !shown.isRecycled && !retired.contains(shown)) shown else null
    if (held != null) {
      holdAndWait(d, held, done)
      return
    }
    // 旧图已经不能再用，先从屏幕上拿掉再截新的，避免画到回收掉的位图
    layer?.setPages(null, null)
    cover(d, false, done)
  }

  /** 没有下一张截图：旧动画已经停了，盖住这一页，等网页换好再播下一次 */
  private fun holdAndWait(d: Int, shown: Bitmap, done: (Boolean) -> Unit) {
    gen++
    resetTurn(d, false)
    outgoing = shown
    fast = false
    val l = showLayer(shown, null)
    if (l == null) {
      phase = Phase.IDLE
      cover(d, false, done)
      return
    }
    phase = Phase.COVERED
    scheduleReadyTimeout()
    done(true)
  }

  private fun cover(d: Int, drag: Boolean, done: (Boolean) -> Unit) {
    if (phase != Phase.IDLE) {
      if (phase == Phase.PREFETCH) prefetchAbort = true
      if (!drag && pendingCover == null && canInterrupt()) return interrupt(d, done)
      // 这一页的图还没出来，或已经有下一次在等。拖动翻页不往队列里排
      if (pendingCover != null || drag) return done(false)
      queuedDir = d
      pendingCover = { cover(d, drag, done) }
      return
    }
    val neighbor = if (d > 0) cacheNext else cachePrev
    if (!drag && neighbor != null && cacheCur != null && anim != "none") return fastTap(d, neighbor, done)
    slowCover(d, drag, done)
  }

  /** 点两侧、纹理还对得上：盖上就播，不再整屏比对。连翻时截图本来就盖着，不用再等窗口上屏 */
  private fun fastTap(d: Int, neighbor: Bitmap, done: (Boolean) -> Unit) {
    val cur = cacheCur
    if (cur == null || !fits(cur) || !fits(neighbor)) return slowCover(d, false, done)
    if (!chainTrust && !cacheFresh()) return slowCover(d, false, done)
    val alreadyCovered = chainTrust
    chainTrust = false
    gen++
    val g = gen
    phase = Phase.CAPTURING
    resetTurn(d, false)
    val l = showLayer(cur, neighbor)
    if (l == null) {
      phase = Phase.IDLE
      return slowCover(d, false, done)
    }
    fast = true
    fastTarget = neighbor
    if (alreadyCovered) {
      playTurn(1f, takeQueuedSpeed()) { motionDone() }
      afterLayerFrame(l) {
        if (g != gen) return@afterLayerFrame
        jumpSent = true
        scheduleReadyTimeout()
        done(true)
      }
      return
    }
    apply(0f)
    afterLayerFrame(l) {
      afterPresented {
        if (g != gen) {
          done(false)
          return@afterPresented
        }
        playTurn(1f, takeQueuedSpeed()) { motionDone() }
        jumpSent = true
        scheduleReadyTimeout()
        done(true)
      }
    }
  }

  /** 这次没能开始动画。点按或接着翻时告诉网页动画已经结束，避免一直停在“正在翻” */
  private fun failCover(drag: Boolean, done: (Boolean) -> Unit) {
    done(false)
    if (!drag && phase == Phase.IDLE && pendingCover == null) notifyDone()
  }

  /** 没有预截：截旧页盖上，网页换好页、截到新页才开始动 */
  private fun slowCover(d: Int, drag: Boolean, done: (Boolean) -> Unit) {
    recycleRetired()
    gen++
    val g = gen
    phase = Phase.CAPTURING
    resetTurn(d, drag)
    retire(outgoing)
    outgoing = null
    val shot = newShot() ?: run {
      phase = Phase.IDLE
      return failCover(drag, done)
    }
    copyWindow(shot) { s ->
      if (g != gen) {
        if (!shot.isRecycled) shot.recycle()
        done(false)
        return@copyWindow
      }
      if (s == null) {
        phase = Phase.IDLE
        return@copyWindow failCover(drag, done)
      }
      prepare(s)
      outgoing = s
      val l = showLayer(s, null)
      if (l == null) {
        phase = Phase.IDLE
        return@copyWindow failCover(drag, done)
      }
      afterLayerFrame(l) {
        if (g != gen) return@afterLayerFrame
        phase = Phase.COVERED
        scheduleReadyTimeout()
        afterPresented {
          if (g == gen) done(true)
        }
      }
    }
  }

  private fun newShot(): Bitmap? {
    val w = web ?: return null
    val width = w.width
    val height = shotHeight(w)
    if (width <= 0 || w.height <= 0) return null
    return try {
      Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    } catch (e: OutOfMemoryError) {
      null
    }
  }

  private fun scratchShot(): Bitmap? {
    val w = web ?: return null
    val s = scratch
    if (s != null && !s.isRecycled && s.width == w.width && s.height == shotHeight(w)) return s
    return newShot().also { scratch = it }
  }

  /** 要显示的截图：确保绘制时用的是新内容，并提前传给 GPU，第一帧不用等上传 */
  private fun prepare(shot: Bitmap) {
    shot.setPixel(0, 0, shot.getPixel(0, 0))
    shot.prepareToDraw()
  }

  /** 从 Activity 窗口拷当前画面。盖在 PopupWindow 里时，拷到的是下面的 WebView */
  private fun copyWindow(shot: Bitmap, done: (Bitmap?) -> Unit) {
    val w = web ?: return done(null)
    val act = activity ?: return done(null)
    // 盖在同一层（没能打开窗口）时只能让 WebView 自己画
    if (layer?.parent != null && popup?.isShowing != true) return done(drawInto(w, shot))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val loc = IntArray(2)
      w.getLocationInWindow(loc)
      val rect = Rect(loc[0], loc[1], loc[0] + shot.width, loc[1] + shot.height)
      try {
        PixelCopy.request(act.window, rect, shot, { result ->
          done(if (result == PixelCopy.SUCCESS) shot else drawInto(w, shot))
        }, main)
      } catch (e: IllegalArgumentException) {
        done(drawInto(w, shot))
      }
    } else {
      done(drawInto(w, shot))
    }
  }

  private fun drawInto(w: WebView, shot: Bitmap): Bitmap? = try {
    w.draw(Canvas(shot))
    shot
  } catch (e: Exception) {
    null
  }

  /**
   * 网页的改动画上屏后截一张和 base 不一样、连着两帧都不变的画面（换章时中间会短暂出现空白页之类的画面，不能截到它）。
   * 最多等 SETTLE_FRAMES 帧；abortable 时预截被打断就不再等。also 不为空时也要和它不一样（上一步显示的画面）
   */
  private fun settleNew(base: Bitmap, g: Int, abortable: Boolean, also: Bitmap?, done: (Bitmap?) -> Unit) {
    whenPainted {
      if (g != gen) return@whenPainted
      val a = newShot() ?: return@whenPainted done(null)
      val b = newShot() ?: run {
        a.recycle()
        return@whenPainted done(null)
      }
      settleNewShot(base, also, a, b, false, SETTLE_FRAMES, g, abortable, done)
    }
  }

  /** shot 是这一次截进去的图，last 是上一次截的（haveLast 表示真的截过） */
  private fun settleNewShot(base: Bitmap, also: Bitmap?, shot: Bitmap, last: Bitmap, haveLast: Boolean, tries: Int, g: Int, abortable: Boolean, done: (Bitmap?) -> Unit) {
    copyWindow(shot) { s ->
      if (g != gen || s == null || base.isRecycled || (abortable && prefetchAbort)) {
        shot.recycle()
        last.recycle()
        if (g == gen) done(null)
        return@copyWindow
      }
      val differs = !s.sameAs(base) && (also == null || also.isRecycled || !s.sameAs(also))
      if (differs && haveLast && s.sameAs(last)) {
        last.recycle()
        prepare(s)
        return@copyWindow done(s)
      }
      if (tries <= 1) {
        last.recycle()
        if (differs) {
          prepare(s)
          done(s)
        } else {
          s.recycle()
          done(null)
        }
        return@copyWindow
      }
      Choreographer.getInstance().postFrameCallback {
        if (g != gen) {
          shot.recycle()
          last.recycle()
        } else {
          settleNewShot(base, also, last, shot, differs, tries - 1, g, abortable, done)
        }
      }
    }
  }

  /** 网页的改动画上屏后，截到和 target 一样的画面为止（最多等 SETTLE_FRAMES 帧），done 的参数是有没有等到 */
  private fun settleTo(target: Bitmap, g: Int, done: (Boolean) -> Unit) {
    whenPainted {
      if (g == gen) settleToShot(target, SETTLE_FRAMES, g, done)
    }
  }

  private fun settleToShot(target: Bitmap, tries: Int, g: Int, done: (Boolean) -> Unit) {
    val shot = scratchShot() ?: return done(false)
    copyWindow(shot) { s ->
      if (g != gen) return@copyWindow
      if (s != null && !target.isRecycled && s.sameAs(target)) return@copyWindow done(true)
      if (s == null || tries <= 1) return@copyWindow done(false)
      Choreographer.getInstance().postFrameCallback {
        if (g == gen) settleToShot(target, tries - 1, g, done)
      }
    }
  }

  private fun layerFor(w: WebView): TurnLayer =
    layer ?: TurnLayer(w.context).also { layer = it }

  /** 阅读页打开时就把（透明的）截图窗口开好 */
  private fun openWindow() {
    val w = web ?: return
    if (w.width <= 0 || w.height <= 0 || w.windowToken == null) return
    val l = layerFor(w)
    if (l.parent != null && popup == null) return
    showPopup(l, w)
  }

  private fun showLayer(out: Bitmap?, inc: Bitmap?): TurnLayer? {
    val w = web ?: return null
    val l = layerFor(w)
    l.setPages(out, inc)
    if (!showPopup(l, w)) return showSibling(l, w)
    return l
  }

  private fun showPopup(l: TurnLayer, w: WebView): Boolean {
    val height = shotHeight(w)
    val pop = popup ?: PopupWindow(l, w.width, height, false).also {
      it.isTouchable = false
      it.isFocusable = false
      // 不可聚焦的弹窗默认排在输入法上面。这层一直开着，搜索时就盖住键盘：
      // 系统按“不受信任的遮挡”丢掉键盘的触摸，ColorOS 还会提示“正在悬浮显示，是否关闭”。
      // 声明需要输入法，系统就把它排到键盘下面
      it.inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED
      it.isClippingEnabled = false
      it.elevation = 0f
      it.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      popup = it
    }
    val loc = IntArray(2)
    w.getLocationInWindow(loc)
    return try {
      if (pop.isShowing) {
        // 位置和大小没变就别 update。这个窗口一更新，有的机型会整屏闪白
        if (pop.width == w.width && pop.height == height && popupX == loc[0] && popupY == loc[1]) return true
        if (pop.width != w.width || pop.height != height) popupFresh = true
        pop.width = w.width
        pop.height = height
        pop.update(loc[0], loc[1], w.width, height)
        popupX = loc[0]
        popupY = loc[1]
      } else {
        pop.width = w.width
        pop.height = height
        pop.showAtLocation(w, Gravity.TOP or Gravity.START, loc[0], loc[1])
        popupX = loc[0]
        popupY = loc[1]
        popupFresh = true
      }
      pop.isShowing
    } catch (e: Exception) {
      false
    }
  }

  private fun showSibling(l: TurnLayer, w: WebView): TurnLayer? {
    val parent = w.parent as? ViewGroup ?: return null
    if (l.parent !== parent) {
      (l.parent as? ViewGroup)?.removeView(l)
      parent.addView(l, parent.indexOfChild(w) + 1, ViewGroup.LayoutParams(w.width, shotHeight(w)))
    }
    l.translationX = w.left.toFloat()
    l.translationY = w.top.toFloat()
    return l
  }

  /** 截图层的这一帧画出来之后再做 action */
  private fun afterLayerFrame(l: TurnLayer, action: () -> Unit) {
    val observer = l.viewTreeObserver
    val listener = object : ViewTreeObserver.OnDrawListener {
      override fun onDraw() {
        main.post {
          if (observer.isAlive) observer.removeOnDrawListener(this)
          action()
        }
      }
    }
    observer.addOnDrawListener(listener)
    l.invalidate()
  }

  /**
   * 截图那一帧交给屏幕之后再做 action：网页要等截图盖住了才能在下面换页。
   * 截图窗口一直开着时下一帧就上屏了；刚打开或改了大小的窗口多等几帧
   */
  private fun afterPresented(action: () -> Unit) {
    var frames = if (popupFresh) 4 else 1
    popupFresh = false
    val choreographer = Choreographer.getInstance()
    val tick = object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        if (--frames > 0) choreographer.postFrameCallback(this)
        else main.post(action)
      }
    }
    choreographer.postFrameCallback(tick)
  }

  /** p 从 0 到 1：0 是旧页完全盖住，1 是新页完全露出来。只改两层截图的位移和透明度 */
  private fun apply(p: Float) {
    val l = layer ?: return
    val w = web ?: return
    progress = p
    val width = w.width.toFloat()
    when (anim) {
      "slide" -> l.place(-dir * p * width, dir * (1 - p) * width, 1f, false)
      "cover" -> if (dir > 0) l.place(-p * width, 0f, 1f, false)
      else l.place(0f, -(1 - p) * width, 1f, true)
      "fade" -> l.place(0f, 0f, 1 - p, false)
      else -> l.place(0f, 0f, 1f, false)
    }
  }

  /** 停掉正在走的翻页动画。先作废代数再停，停掉的回调就不会再收尾一次 */
  private fun stopMotion() {
    motionToken++
    motionFrame?.let { Choreographer.getInstance().removeFrameCallback(it) }
    motionFrame = null
    animator?.cancel()
    animator = null
  }

  /**
   * 跟屏幕刷新一帧帧走。用 Choreographer 而不是 ValueAnimator：部分机型会把属性动画压到低于屏幕刷新率。
   */
  private fun animateTo(target: Float, duration: Long, ease: TimeInterpolator, then: () -> Unit) {
    stopMotion()
    val token = motionToken
    val from = progress
    val durNs = duration.coerceAtLeast(1L) * 1_000_000L
    var startNs = 0L
    val cb = object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        if (token != motionToken) return
        if (startNs == 0L) startNs = frameTimeNanos
        val t = ((frameTimeNanos - startNs).toFloat() / durNs.toFloat()).coerceIn(0f, 1f)
        apply(from + (target - from) * ease.getInterpolation(t))
        if (t < 1f) {
          Choreographer.getInstance().postFrameCallback(this)
        } else {
          motionFrame = null
          apply(target)
          then()
        }
      }
    }
    motionFrame = cb
    phase = Phase.ANIMATING
    Choreographer.getInstance().postFrameCallback(cb)
  }

  /** 收尾：没有下一页就揭掉截图。有下一页就留着，马上接着播，避免中间闪一帧 */
  private fun finish() {
    val next = pendingCover
    pendingCover = null
    queuedDir = 0
    gen++
    stopMotion()
    catchUp?.cancel()
    catchUp = null
    clearReadyTimeout()
    if (pageChanged) seedCache()
    if (pictureStale) {
      dropCache()
      pictureStale = false
    }
    // 缓存已经丢掉时，截图层里可能还画着即将回收的图，先清空再回收
    if (next == null || cacheCur == null) {
      layer?.let {
        it.setPages(null, null)
        if (popup == null) (it.parent as? ViewGroup)?.removeView(it)
      }
    }
    retire(outgoing)
    retire(incoming)
    outgoing = null
    incoming = null
    phase = Phase.IDLE
    resetTurn(dir, false)
    chainTrust = false
    if (next != null) next() else notifyDone()
  }

  /**
   * 换了页：翻到的那页就是新的当前页，刚离开的那页是它旁边的一页，接着往回翻马上能用；
   * 另一边等网页再让预截时补上。确认不了新页的样子就整套作废
   */
  private fun keepShot(b: Bitmap?, vararg skip: Bitmap?): Bitmap? {
    if (b == null || b.isRecycled) return null
    if (skip.any { it === b }) return null
    return b
  }

  private fun seedCache() {
    if (pictureStale) return dropCache()
    val landedOn = when {
      fast && landedSame -> fastTarget
      !fast -> incoming
      else -> null
    }
    val left = if (fast) cacheCur else outgoing
    if (landedOn == null || left == null || landedOn.isRecycled || left.isRecycled) return dropCache()
    val oldNext = cacheNext
    val oldNext2 = cacheNext2
    val oldNext3 = cacheNext3
    val oldNext4 = cacheNext4
    val oldPrev = cachePrev
    val oldPrev2 = cachePrev2
    // 往后留四页，往回留两页。翻过一页后整窗往前挪，多出来的那张丢掉
    val newPrev: Bitmap?
    val newPrev2: Bitmap?
    val newNext: Bitmap?
    val newNext2: Bitmap?
    val newNext3: Bitmap?
    val newNext4: Bitmap?
    if (dir > 0) {
      newPrev = left
      newPrev2 = keepShot(oldPrev, left, landedOn)
      newNext = keepShot(oldNext2, left, landedOn)
      newNext2 = keepShot(oldNext3, left, landedOn)
      newNext3 = keepShot(oldNext4, left, landedOn)
      newNext4 = null
    } else {
      newNext = left
      newNext2 = keepShot(oldNext, left, landedOn)
      newNext3 = keepShot(oldNext2, left, landedOn)
      newNext4 = keepShot(oldNext3, left, landedOn)
      newPrev = keepShot(oldPrev2, left, landedOn)
      newPrev2 = null
    }
    val keep = listOfNotNull(landedOn, newPrev, newPrev2, newNext, newNext2, newNext3, newNext4)
    for (b in listOf(cacheCur, oldNext, oldNext2, oldNext3, oldNext4, oldPrev, oldPrev2)) {
      if (b != null && keep.none { it === b }) retire(b)
    }
    cacheCur = landedOn
    cachePrev = newPrev
    cachePrev2 = newPrev2
    cacheNext = newNext
    cacheNext2 = newNext2
    cacheNext3 = newNext3
    cacheNext4 = newNext4
    if (outgoing === left) outgoing = null
    if (incoming === landedOn) incoming = null
    cacheGen = pageGen
  }

  private fun dropCache() {
    retire(cacheCur)
    retire(cacheNext)
    retire(cacheNext2)
    retire(cacheNext3)
    retire(cacheNext4)
    retire(cachePrev)
    retire(cachePrev2)
    cacheCur = null
    cacheNext = null
    cacheNext2 = null
    cacheNext3 = null
    cacheNext4 = null
    cachePrev = null
    cachePrev2 = null
    cacheGen = -1
  }

  private fun notifyDone() {
    web?.evaluateJavascript("window.__sparkTurn&&window.__sparkTurn('done',0)", null)
  }

  private fun retire(shot: Bitmap?) {
    if (shot != null && !shot.isRecycled && !retired.contains(shot)) retired.add(shot)
  }

  /** 还在纹理槽或截图层里的图不能回收 */
  private fun held(b: Bitmap): Boolean =
    b === cacheCur || b === cacheNext || b === cacheNext2 || b === cacheNext3 || b === cacheNext4 ||
      b === cachePrev || b === cachePrev2 || b === outgoing || b === incoming || b === fastTarget ||
      b === scratch || b === mismatch

  private fun recycleIfLoose(b: Bitmap?) {
    if (b == null || b.isRecycled || held(b)) return
    b.recycle()
  }

  private fun recycleRetired() {
    for (shot in retired) {
      if (shot !== cacheCur && shot !== cacheNext && shot !== cacheNext2 && shot !== cacheNext3 && shot !== cacheNext4 && shot !== cachePrev && shot !== cachePrev2) shot.recycle()
    }
    retired.clear()
  }

  /** WebView 把调用之前的网页改动画到屏幕上之后再做 action；最多等 PAINT_TIMEOUT_MS */
  private fun whenPainted(action: () -> Unit) {
    val w = web ?: return action()
    var done = false
    val run = Runnable {
      if (!done) {
        done = true
        action()
      }
    }
    w.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
      override fun onComplete(requestId: Long) {
        main.post(run)
      }
    })
    main.postDelayed(run, PAINT_TIMEOUT_MS)
  }

  /** 截图拿掉后的那一帧画出来了再截下一张，不然会截到动画里的半截画面 */
  private fun afterNextFrame(action: () -> Unit) {
    val root = web?.rootView ?: return action()
    val observer = root.viewTreeObserver
    val listener = object : ViewTreeObserver.OnDrawListener {
      override fun onDraw() {
        main.post {
          if (observer.isAlive) observer.removeOnDrawListener(this)
          action()
        }
      }
    }
    observer.addOnDrawListener(listener)
    root.invalidate()
  }

  private fun scheduleReadyTimeout() {
    clearReadyTimeout()
    val r = Runnable { finish() }
    readyTimeout = r
    main.postDelayed(r, READY_TIMEOUT_MS)
  }

  private fun clearReadyTimeout() {
    readyTimeout?.let { main.removeCallbacks(it) }
    readyTimeout = null
  }

  private fun callJs(kind: String, d: Int) {
    val w = web ?: return finish()
    w.evaluateJavascript("window.__sparkTurn ? (window.__sparkTurn('$kind', $d), true) : false") { result ->
      if (result != "true" && kind != "edge") finish()
    }
  }

  /**
   * 旧页、新页两层截图。动画只改位移和透明度。
   * 不在每一帧改裁剪：setClipBounds 会让这一层每帧重画整页位图，高刷新率也上不去。
   */
  private class TurnLayer(context: Context) : FrameLayout(context) {
    private val outPage = PageView(context)
    private val inPage = PageView(context)
    private var inFront = false

    init {
      setBackgroundColor(Color.TRANSPARENT)
      addView(inPage, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      addView(outPage, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun setPages(out: Bitmap?, inc: Bitmap?) {
      outPage.bitmap = out
      inPage.bitmap = inc
      place(0f, 0f, 1f, false)
    }

    /** inFront：往回翻的覆盖，新页从左边盖上来，要在旧页上面 */
    fun place(outX: Float, inX: Float, outAlpha: Float, inFront: Boolean) {
      outPage.translationX = outX
      inPage.translationX = inX
      outPage.alpha = outAlpha
      if (inFront != this.inFront) {
        this.inFront = inFront
        (if (inFront) inPage else outPage).bringToFront()
      }
    }

    override fun hasOverlappingRendering(): Boolean = false
  }

  private class PageView(context: Context) : View(context) {
    private val paint = Paint()
    var bitmap: Bitmap? = null
      set(value) {
        if (field === value) return
        field = value
        // 硬件层把位图留在 GPU 上。之后只改 translationX / alpha，不再每帧把整页传一遍
        setLayerType(if (value != null && !value.isRecycled) LAYER_TYPE_HARDWARE else LAYER_TYPE_NONE, null)
        invalidate()
      }

    init {
      setBackgroundColor(Color.TRANSPARENT)
    }

    override fun onDraw(canvas: Canvas) {
      val b = bitmap ?: return
      if (!b.isRecycled) canvas.drawBitmap(b, 0f, 0f, paint)
    }

    override fun hasOverlappingRendering(): Boolean = false
  }

  /** 网页选字时调用。方法要 public，系统才能从 JavaScript 调到 */
  class SelectingFlag {
    @JavascriptInterface
    fun set(on: Boolean) {
      textSelecting = on
    }
  }

  /** 网页排版代数。方法要 public，系统才能从 JavaScript 调到 */
  class PictureFlag {
    @JavascriptInterface
    fun setGeneration(value: Int) {
      main.post { noteGeneration(value) }
    }
  }
}
