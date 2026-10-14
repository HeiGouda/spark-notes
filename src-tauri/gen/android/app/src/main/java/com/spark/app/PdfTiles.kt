package com.spark.app

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.pdf.PdfRenderer
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Size
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.OverScroller
import org.json.JSONArray
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * PDF 用系统渲染器画。
 *
 * 每页先按整页大小画一张底图（当前页和前后各一页）。缩放、拖动时只变换底图，手指走多少页面就走多少，
 * 不会露出空白；手停下后再按当前比例把屏幕上这一块画清楚，盖在底图上。
 * 没放大时左右拖动翻页；放大后单指拖动、甩动看页面各处，拖到左右尽头再往外拖就翻页。双击放大或还原。
 */
class PdfTiles(context: android.content.Context) : View(context) {
  private val main = Handler(Looper.getMainLooper())
  private val thread = HandlerThread("pdf-tiles").apply { start() }
  private val bg = Handler(thread.looper)
  private val gate = Any()
  private var web: WebView? = null
  private var pfd: ParcelFileDescriptor? = null
  private var renderer: PdfRenderer? = null
  /** 换文件、关文件时加一，渲染线程上还没做完的活就作废 */
  @Volatile private var fileGen = 0
  @Volatile private var pageIndex = 0
  private var pageCount = 0
  private var color = Color.WHITE

  /** 各页尺寸（PDF 点）。渲染线程打开页时记下，主线程排版用 */
  private val sizes = ConcurrentHashMap<Int, Size>()
  private val bases = HashMap<Int, Bitmap>()
  private val baseAsked = HashSet<Int>()

  /** 相对整页适配的放大倍数，1 是整页放得下 */
  private var scale = 1f
  /** 当前页左上角在视图里的位置 */
  private var tx = 0f
  private var ty = 0f
  /** 翻页拖动的横向位移，负数是往下一页拖 */
  private var slide = 0f

  private var detail: Bitmap? = null
  private var detailPage = -1
  private var detailScale = 1f
  private var detailTx = 0f
  private var detailTy = 0f
  @Volatile private var detailToken = 0
  private val detailRun = Runnable { renderDetail() }

  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val pageFill = Paint().apply { color = Color.WHITE }
  private var holes = emptyList<RectF>()
  private val clipPath = Path()
  private val scroller = OverScroller(context)
  private var anim: ValueAnimator? = null
  private var scaling = false
  /** 这一次触摸里双指缩放过，剩下的单指移动不算拖动、松手不算点按 */
  private var pinched = false
  private var tapDone = false
  private var flingVx = 0f
  private var lastFocusX = 0f
  private var lastFocusY = 0f
  /** 放大时只有按下时已经贴着左右边，往外拖才算翻页，免得上下看的时候误翻 */
  private var edgeLeft = false
  private var edgeRight = false

  private val density get() = resources.displayMetrics.density

  private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
      scaling = true
      pinched = true
      lastFocusX = detector.focusX
      lastFocusY = detector.focusY
      if (slide != 0f) slide = 0f
      main.removeCallbacks(detailRun)
      return true
    }

    override fun onScale(detector: ScaleGestureDetector): Boolean {
      val next = (scale * detector.scaleFactor).coerceIn(MIN_PINCH, MAX_SCALE)
      val k = next / scale
      val fx = detector.focusX
      val fy = detector.focusY
      // 绕两指中点缩放，同时跟着两指一起平移
      tx = fx - (fx - tx) * k + (fx - lastFocusX)
      ty = fy - (fy - ty) * k + (fy - lastFocusY)
      lastFocusX = fx
      lastFocusY = fy
      scale = next
      invalidate()
      return true
    }

    override fun onScaleEnd(detector: ScaleGestureDetector) {
      scaling = false
      settle()
    }
  })

  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(e: MotionEvent): Boolean = true

    override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
      if (scaling || pinched || e2.pointerCount > 1) return true
      if (slide != 0f) {
        slide = damp(slide - distanceX)
        invalidate()
        return true
      }
      val nx = tx - distanceX
      val ny = ty - distanceY
      tx = clampX(nx)
      ty = clampY(ny)
      val excess = nx - tx
      val zoomed = scale > 1.01f
      val outward = (excess < 0f && (!zoomed || edgeRight)) || (excess > 0f && (!zoomed || edgeLeft))
      if (abs(excess) > 0.5f && abs(distanceX) > abs(distanceY) && outward) slide = damp(excess)
      invalidate()
      return true
    }

    override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
      if (pinched) return true
      flingVx = velocityX
      if (slide != 0f || scale <= 1.01f) return true
      val w = pageW(pageIndex)
      val h = pageH(pageIndex)
      val minX = if (w > width) (width - w).roundToInt() else tx.roundToInt()
      val maxX = if (w > width) 0 else tx.roundToInt()
      val minY = if (h > height) (height - h).roundToInt() else ty.roundToInt()
      val maxY = if (h > height) 0 else ty.roundToInt()
      scroller.fling(tx.roundToInt(), ty.roundToInt(), velocityX.roundToInt(), velocityY.roundToInt(), minX, maxX, minY, maxY)
      postInvalidateOnAnimation()
      return true
    }

    override fun onSingleTapUp(e: MotionEvent): Boolean {
      if (pinched) return true
      // 没放大时点两侧马上翻页，不等双击判定
      val zone = zoneOf(e.x)
      if (scale <= 1.01f && zone != "menu") {
        tapDone = true
        tap(zone)
      }
      return true
    }

    override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
      if (pinched || tapDone) return true
      // 放大后在看局部，点哪里都只是呼出、收起菜单，不翻页
      tap(if (scale > 1.01f) "menu" else zoneOf(e.x))
      return true
    }

    override fun onDoubleTap(e: MotionEvent): Boolean {
      if (pinched) return true
      tapDone = true
      if (scale > 1.05f) zoomTo(1f, e.x, e.y) else zoomTo(DOUBLE_TAP_SCALE, e.x, e.y)
      return true
    }
  })

  init {
    setBackgroundColor(Color.TRANSPARENT)
    isClickable = true
    gestures.setIsLongpressEnabled(false)
    // 双击已经用来放大、还原，不要再让“双击后拖动”也去缩放
    scaleDetector.isQuickScaleEnabled = false
  }

  fun bind(webView: WebView) {
    web = webView
  }

  fun bridge(): Bridge = Bridge()

  private fun place(l: Double, t: Double, w: Double, h: Double) {
    val webView = web ?: return
    val widthPx = (w * density).roundToInt().coerceAtLeast(1)
    val heightPx = (h * density).roundToInt().coerceAtLeast(1)
    x = webView.x + (l * density).toFloat()
    y = webView.y + (t * density).toFloat()
    val lp = layoutParams ?: return
    if (lp.width != widthPx || lp.height != heightPx) {
      lp.width = widthPx
      lp.height = heightPx
      layoutParams = lp
    }
    val group = parent as? android.view.ViewGroup
    if (group != null && group.getChildAt(group.childCount - 1) !== this) bringToFront()
  }

  // ---- 几何 ----

  private fun sizeOf(index: Int): Size? = sizes[index] ?: sizes[pageIndex] ?: sizes.values.firstOrNull()

  private fun fitOf(index: Int): Float {
    val s = sizeOf(index) ?: return 1f
    return min(width / s.width.coerceAtLeast(1).toFloat(), height / s.height.coerceAtLeast(1).toFloat())
  }

  private fun pageW(index: Int, s: Float = scale): Float {
    val size = sizeOf(index) ?: return width * s
    return size.width * fitOf(index) * s
  }

  private fun pageH(index: Int, s: Float = scale): Float {
    val size = sizeOf(index) ?: return height * s
    return size.height * fitOf(index) * s
  }

  /** 页比视图窄就居中，宽就不让边露出空白 */
  private fun clampX(x: Float, s: Float = scale): Float {
    val w = pageW(pageIndex, s)
    return if (w <= width) (width - w) / 2f else x.coerceIn(width - w, 0f)
  }

  private fun clampY(y: Float, s: Float = scale): Float {
    val h = pageH(pageIndex, s)
    return if (h <= height) (height - h) / 2f else y.coerceIn(height - h, 0f)
  }

  private fun resetView() {
    stopMotion()
    scale = 1f
    slide = 0f
    tx = clampX(0f)
    ty = clampY(0f)
    dropDetail()
  }

  private fun canGo(dir: Int): Boolean = if (dir > 0) pageIndex + 1 < pageCount else pageIndex > 0

  /** 往没有页的一侧拖，只给一点阻尼 */
  private fun damp(value: Float): Float {
    val dir = if (value < 0f) 1 else -1
    return if (canGo(dir)) value.coerceIn(-width.toFloat(), width.toFloat()) else value * 0.3f
  }

  private fun zoneOf(x: Float): String = when {
    x < width * 0.3f -> "prev"
    x > width * 0.7f -> "next"
    else -> "menu"
  }

  // ---- 画 ----

  override fun onDraw(canvas: Canvas) {
    val checkpoint = canvas.save()
    if (holes.isNotEmpty()) {
      clipPath.rewind()
      clipPath.fillType = Path.FillType.EVEN_ODD
      clipPath.addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
      for (hole in holes) clipPath.addRect(hole, Path.Direction.CCW)
      canvas.clipPath(clipPath)
    }
    canvas.drawColor(color)
    if (renderer != null && pageCount > 0) {
      drawPage(canvas, pageIndex, tx + slide, ty, scale, true)
      if (slide < 0f && canGo(1)) drawNeighbor(canvas, pageIndex + 1, slide + width)
      else if (slide > 0f && canGo(-1)) drawNeighbor(canvas, pageIndex - 1, slide - width)
    }
    canvas.restoreToCount(checkpoint)
  }

  private fun drawNeighbor(canvas: Canvas, index: Int, shift: Float) {
    val w = pageW(index, 1f)
    val h = pageH(index, 1f)
    drawPage(canvas, index, (width - w) / 2f + shift, if (h <= height) (height - h) / 2f else 0f, 1f, false)
  }

  private fun drawPage(canvas: Canvas, index: Int, left: Float, top: Float, s: Float, sharp: Boolean) {
    val rect = RectF(left, top, left + pageW(index, s), top + pageH(index, s))
    if (rect.right < 0f || rect.left > width) return
    canvas.drawRect(rect, pageFill)
    val base = bases[index]
    if (base != null && !base.isRecycled) canvas.drawBitmap(base, null, rect, paint)
    val d = detail
    if (!sharp || d == null || d.isRecycled || detailPage != index || s <= 1.01f) return
    val r = s / detailScale
    canvas.save()
    canvas.clipRect(rect)
    canvas.translate(left - detailTx * r, top - detailTy * r)
    canvas.scale(r, r)
    canvas.drawBitmap(d, 0f, 0f, paint)
    canvas.restore()
  }

  override fun computeScroll() {
    if (!scroller.isFinished && scroller.computeScrollOffset()) {
      tx = clampX(scroller.currX.toFloat())
      ty = clampY(scroller.currY.toFloat())
      postInvalidateOnAnimation()
      if (scroller.isFinished) scheduleDetail()
    }
  }

  // ---- 渲染 ----

  /** 当前页和前后各一页的底图，别的页丢掉 */
  private fun wantBases() {
    val keep = (pageIndex - 1..pageIndex + 1).filter { it in 0 until pageCount }.toSet()
    for (key in bases.keys.toList()) if (key !in keep) bases.remove(key)?.recycle()
    for (i in intArrayOf(pageIndex, pageIndex + 1, pageIndex - 1)) {
      if (i in keep && bases[i] == null && baseAsked.add(i)) renderBase(i)
    }
  }

  private fun renderBase(index: Int) {
    val gen = fileGen
    val viewW = width
    val viewH = height
    if (viewW <= 1 || viewH <= 1) {
      baseAsked.remove(index)
      return
    }
    bg.post {
      var bmp: Bitmap? = null
      if (gen == fileGen && abs(index - pageIndex) <= 1) {
        synchronized(gate) {
          val pdf = renderer
          if (pdf != null && gen == fileGen) {
            var page: PdfRenderer.Page? = null
            try {
              page = pdf.openPage(index)
              val pw = page.width.coerceAtLeast(1)
              val ph = page.height.coerceAtLeast(1)
              sizes[index] = Size(pw, ph)
              val fit = min(viewW / pw.toFloat(), viewH / ph.toFloat())
              val bw = (pw * fit).roundToInt().coerceAtLeast(1)
              val bh = (ph * fit).roundToInt().coerceAtLeast(1)
              val out = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
              out.eraseColor(Color.WHITE)
              val m = Matrix().apply { postScale(bw / pw.toFloat(), bh / ph.toFloat()) }
              page.render(out, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              bmp = out
            } catch (_: Throwable) {
              bmp?.recycle()
              bmp = null
            } finally {
              try {
                page?.close()
              } catch (_: Throwable) {
              }
            }
          }
        }
      }
      val made = bmp
      main.post publish@{
        baseAsked.remove(index)
        if (made == null) return@publish
        if (gen != fileGen || abs(index - pageIndex) > 1 || viewW != width || viewH != height) {
          made.recycle()
          return@publish
        }
        bases.put(index, made)?.recycle()
        // 第一次拿到这一页的尺寸时重新摆正
        if (index == pageIndex && scale <= 1.001f && slide == 0f && anim == null) {
          tx = clampX(tx)
          ty = clampY(ty)
        }
        invalidate()
      }
    }
  }

  private fun scheduleDetail(delay: Long = 120L) {
    main.removeCallbacks(detailRun)
    if (scale > 1.01f) main.postDelayed(detailRun, delay)
  }

  private fun dropDetail() {
    detailToken++
    main.removeCallbacks(detailRun)
    detail?.recycle()
    detail = null
    detailPage = -1
  }

  /** 按现在的比例把屏幕上这一块画清楚。手还在动时不画 */
  private fun renderDetail() {
    if (scale <= 1.01f || slide != 0f || anim != null || scaling || !scroller.isFinished) return
    val token = ++detailToken
    val gen = fileGen
    val index = pageIndex
    val s = scale
    val left = tx
    val top = ty
    val viewW = width
    val viewH = height
    if (viewW <= 1 || viewH <= 1) return
    bg.postAtFrontOfQueue {
      if (token != detailToken || gen != fileGen) return@postAtFrontOfQueue
      var bmp: Bitmap? = null
      synchronized(gate) {
        val pdf = renderer
        if (pdf != null && gen == fileGen) {
          var page: PdfRenderer.Page? = null
          try {
            page = pdf.openPage(index)
            val pw = page.width.coerceAtLeast(1)
            val ph = page.height.coerceAtLeast(1)
            val k = min(viewW / pw.toFloat(), viewH / ph.toFloat()) * s
            val out = Bitmap.createBitmap(viewW, viewH, Bitmap.Config.ARGB_8888)
            Canvas(out).drawRect(left, top, left + pw * k, top + ph * k, Paint().apply { color = Color.WHITE })
            val m = Matrix().apply {
              postScale(k, k)
              postTranslate(left, top)
            }
            page.render(out, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bmp = out
          } catch (_: Throwable) {
            bmp?.recycle()
            bmp = null
          } finally {
            try {
              page?.close()
            } catch (_: Throwable) {
            }
          }
        }
      }
      val made = bmp ?: return@postAtFrontOfQueue
      main.post publish@{
        if (token != detailToken || gen != fileGen || index != pageIndex) {
          made.recycle()
          return@publish
        }
        detail?.recycle()
        detail = made
        detailPage = index
        detailScale = s
        detailTx = left
        detailTy = top
        invalidate()
      }
    }
  }

  // ---- 动作 ----

  private fun stopMotion() {
    anim?.cancel()
    anim = null
    if (!scroller.isFinished) scroller.forceFinished(true)
  }

  private fun animate(duration: Long, step: (Float) -> Unit, done: () -> Unit) {
    anim?.cancel()
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = duration
    a.interpolator = DecelerateInterpolator()
    a.addUpdateListener {
      step(it.animatedValue as Float)
      invalidate()
    }
    a.addListener(object : android.animation.AnimatorListenerAdapter() {
      private var cancelled = false
      override fun onAnimationCancel(animation: android.animation.Animator) {
        cancelled = true
      }

      override fun onAnimationEnd(animation: android.animation.Animator) {
        if (anim === a) anim = null
        if (!cancelled) done()
      }
    })
    anim = a
    a.start()
  }

  /** 缩放到 target，(fx, fy) 下面的那一点不动，最后不露空白 */
  private fun zoomTo(target: Float, fx: Float, fy: Float) {
    val s0 = scale
    val x0 = tx
    val y0 = ty
    val s1 = target.coerceIn(1f, MAX_SCALE)
    val x1 = clampX(fx - (fx - x0) * (s1 / s0), s1)
    val y1 = clampY(fy - (fy - y0) * (s1 / s0), s1)
    main.removeCallbacks(detailRun)
    animate(220L, { t ->
      scale = s0 + (s1 - s0) * t
      tx = x0 + (x1 - x0) * t
      ty = y0 + (y1 - y0) * t
    }) {
      scale = s1
      tx = x1
      ty = y1
      if (s1 <= 1.01f) dropDetail() else scheduleDetail(0L)
    }
  }

  /** 捏完以后：比整页小就弹回整页，边露出空白就推回去 */
  private fun settle() {
    if (scale < 1f) {
      zoomTo(1f, width / 2f, height / 2f)
      return
    }
    val x1 = clampX(tx)
    val y1 = clampY(ty)
    if (abs(x1 - tx) < 0.5f && abs(y1 - ty) < 0.5f) {
      scheduleDetail()
      return
    }
    val x0 = tx
    val y0 = ty
    animate(180L, { t ->
      tx = x0 + (x1 - x0) * t
      ty = y0 + (y1 - y0) * t
    }) { scheduleDetail(0L) }
  }

  private fun slideTo(target: Float, done: () -> Unit) {
    val from = slide
    val duration = (240f * abs(target - from) / width.coerceAtLeast(1)).toLong().coerceIn(90L, 240L)
    animate(duration, { t -> slide = from + (target - from) * t }) {
      slide = target
      done()
    }
  }

  /** 松手：翻页拖动够远或甩得够快就翻过去，不然弹回来 */
  private fun release() {
    if (slide == 0f) {
      if (!scaling && anim == null && scroller.isFinished) scheduleDetail()
      return
    }
    val dir = if (slide < 0f) 1 else -1
    val fast = abs(flingVx) > 700f * density && (flingVx < 0f) == (dir > 0)
    val far = abs(slide) > width * 0.22f
    if ((fast || far) && canGo(dir)) {
      slideTo(-dir * width.toFloat()) { commitTurn(dir) }
    } else {
      if ((fast || far) && !canGo(dir)) edge(dir)
      slideTo(0f) { scheduleDetail() }
    }
  }

  private fun commitTurn(dir: Int) {
    pageIndex = (pageIndex + dir).coerceIn(0, (pageCount - 1).coerceAtLeast(0))
    resetView()
    wantBases()
    report()
    invalidate()
  }

  private fun turn(dir: Int) {
    if (!canGo(dir)) {
      edge(dir)
      return
    }
    stopMotion()
    slideTo(-dir * width.toFloat()) { commitTurn(dir) }
  }

  private fun tap(zone: String) {
    web?.post { web?.evaluateJavascript("window.__sparkPdfTap&&window.__sparkPdfTap('$zone')", null) }
  }

  private fun edge(dir: Int) {
    web?.post { web?.evaluateJavascript("window.__sparkPdfEdge&&window.__sparkPdfEdge($dir)", null) }
  }

  private fun report() {
    val count = pageCount
    val index = pageIndex
    web?.post { web?.evaluateJavascript("window.__sparkPdfPage&&window.__sparkPdfPage($index,$count)", null) }
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (visibility != VISIBLE || renderer == null) return false
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      if (holes.any { it.contains(event.x, event.y) }) return false
      pinched = false
      tapDone = false
      flingVx = 0f
      // 翻页动画还在走就直接走完，不然新的拖动接不上
      anim?.end()
      if (!scroller.isFinished) scroller.forceFinished(true)
      main.removeCallbacks(detailRun)
      val w = pageW(pageIndex)
      edgeLeft = w <= width || tx >= -1f
      edgeRight = w <= width || tx <= width - w + 1f
    }
    scaleDetector.onTouchEvent(event)
    gestures.onTouchEvent(event)
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) release()
    return true
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0 || renderer == null) return
    for (bmp in bases.values) bmp.recycle()
    bases.clear()
    resetView()
    wantBases()
    invalidate()
  }

  // ---- 文件 ----

  private fun openFile(path: String) {
    closeFile()
    val file = File(path)
    if (!file.isFile) return
    val fd = try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (_: Exception) {
      return
    }
    val pdf = try {
      PdfRenderer(fd)
    } catch (_: Exception) {
      fd.close()
      return
    }
    synchronized(gate) {
      pfd = fd
      renderer = pdf
      pageCount = pdf.pageCount
    }
    pageIndex = pageIndex.coerceIn(0, (pageCount - 1).coerceAtLeast(0))
    resetView()
    wantBases()
    report()
    invalidate()
  }

  private fun closeFile() {
    fileGen++
    stopMotion()
    dropDetail()
    val pdf: PdfRenderer?
    val fd: ParcelFileDescriptor?
    synchronized(gate) {
      pdf = renderer
      fd = pfd
      renderer = null
      pfd = null
      pageCount = 0
    }
    try {
      pdf?.close()
    } catch (_: Exception) {
    }
    try {
      fd?.close()
    } catch (_: Exception) {
    }
    for (bmp in bases.values) bmp.recycle()
    bases.clear()
    baseAsked.clear()
    sizes.clear()
  }

  private fun parseHoles(json: String): List<RectF> {
    val array = try {
      JSONArray(json)
    } catch (_: Exception) {
      return emptyList()
    }
    val out = ArrayList<RectF>()
    for (i in 0 until array.length()) {
      val obj = array.optJSONObject(i) ?: continue
      val left = (obj.optDouble("x") * density).toFloat()
      val top = (obj.optDouble("y") * density).toFloat()
      val right = left + (obj.optDouble("w") * density).toFloat()
      val bottom = top + (obj.optDouble("h") * density).toFloat()
      if (right - left > 1f && bottom - top > 1f) out.add(RectF(left, top, right, bottom))
    }
    return out
  }

  inner class Bridge {
    @JavascriptInterface
    fun open(path: String) {
      main.post { openFile(path) }
    }

    @JavascriptInterface
    fun close() {
      main.post {
        closeFile()
        visibility = GONE
      }
    }

    @JavascriptInterface
    fun setVisible(on: Boolean) {
      main.post { visibility = if (on) VISIBLE else GONE }
    }

    @JavascriptInterface
    fun setFrame(l: Double, t: Double, w: Double, h: Double) {
      main.post { place(l, t, w, h) }
    }

    /** 菜单栏的位置不画页面，触摸也交回网页。单位是 CSS 像素 */
    @JavascriptInterface
    fun setHoles(json: String) {
      main.post {
        val next = parseHoles(json)
        if (next == holes) return@post
        holes = next
        invalidate()
      }
    }

    @JavascriptInterface
    fun setPage(index: Int) {
      main.post {
        if (pageCount <= 0) {
          pageIndex = index.coerceAtLeast(0)
          return@post
        }
        val next = index.coerceIn(0, pageCount - 1)
        if (next == pageIndex && bases[next] != null) return@post
        pageIndex = next
        resetView()
        wantBases()
        report()
        invalidate()
      }
    }

    @JavascriptInterface
    fun turn(dir: Int) {
      main.post { this@PdfTiles.turn(if (dir < 0) -1 else 1) }
    }

    @JavascriptInterface
    fun setColor(hex: String) {
      main.post {
        color = try {
          Color.parseColor(hex)
        } catch (_: Exception) {
          Color.WHITE
        }
        invalidate()
      }
    }
  }

  companion object {
    private const val MAX_SCALE = 6f
    /** 捏的时候可以比整页再小一点，松手弹回 */
    private const val MIN_PINCH = 0.7f
    private const val DOUBLE_TAP_SCALE = 2.5f
  }
}
