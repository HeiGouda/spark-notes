package com.spark.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.Base64
import android.view.Choreographer
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 左右翻页的原生排版。
 *
 * 正文用 StaticLayout 排成一页一页，图单独占一块，先画进位图。
 * 普通段落按字量宽，非末行先挤压标点再两端对齐。标题和预格式仍用 StaticLayout。
 * 手指移动时平移这些位图；位图还没好就直接画已经排好的字。
 * 上下滚动用同一套行盒整章竖滑，不再退回网页。
 * 竖排、从右向左、表格这些复杂章仍交给网页，位置按章节交接。
 */
class NativePages(context: android.content.Context) : View(context) {
  private val main = Handler(Looper.getMainLooper())
  private val layoutThread = android.os.HandlerThread(
    "native-pages",
    android.os.Process.THREAD_PRIORITY_DISPLAY,
  ).apply { start() }
  private val layoutHandler = Handler(layoutThread.looper)
  private val layoutTicket = HashMap<Int, Int>()
  private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val contentImagePaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val pageFill = Paint()
  private val pageHighlight = Paint().apply { color = Color.argb(96, 250, 204, 70) }
  private val markPaint = Paint().apply { color = Color.argb(96, 47, 111, 237) }
  private var web: WebView? = null

  private var bg = Color.WHITE
  private var fg = Color.BLACK
  private var textPx = 18f
  private var leading = 1.8f
  private var marginFrac = 0.07f
  private var anim = "slide"
  private var faceName = "\u0000"
  private var face: Typeface = Typeface.SERIF

  private var scrollMode = false
  /** 上下滚动时屏幕顶到当前章顶的距离。可以暂时是负的或超过这一章，前后章接着画 */
  private var scrollY = 0f
  private val flinger = android.widget.OverScroller(context)
  private var flingY = 0
  /** 排版重来后要回到的那一行：字符下标，和屏幕顶比那一行低了多少 */
  private var scrollKeep: Pair<Int, Float>? = null
  /** 向网页要章节的时间，滑动中每帧都会判断，别反复要 */
  private val askedAt = HashMap<String, Long>()
  private val webChapters = HashSet<Int>()
  private var chapter = 0
  private var page = 0
  private val texts = HashMap<Int, List<Block>>()
  private val laid = HashMap<Int, Laid>()
  /** 已经交给原生的那一份正文。相同就不再解析、不再排 */
  private val payloadKeys = HashMap<Int, Long>()
  /** 当前 texts 对应的正文。分页完成时再抄到 laidKeys */
  private val textKeys = HashMap<Int, Long>()
  /** 当前分页结果对应的正文 */
  private val laidKeys = HashMap<Int, Long>()
  private val markCache = HashMap<Int, List<Pair<Int, Int>>>()
  private var quoteStamp = 0
  private var cachedQuoteStamp = -1
  private val shots = HashMap<Key, Bitmap>()
  private val nextOf = HashMap<Int, Int>()
  private val prevOf = HashMap<Int, Int>()
  /** 划线是章节里的字符区间，不再按摘录全文查找 */
  private var marks = emptyList<MarkSpan>()
  /** 章末已经翻过去，但下一章的正文还没到。到了就接上，不再弹回去 */
  private var pendingJump = 0
  /** 这一侧已经向网页要过章节，避免滑动过程中重复要 */
  private var askedDir = 0

  private var offset = 0f
  private var downX = 0f
  private var downY = 0f
  private var dragging = false
  private var moved = false
  private var selecting = false
  /** 这一下触摸刚刚长按选出了字，松手时先留着，不要马上清掉 */
  private var selectionGesture = false
  private var selA = -1
  private var selB = -1
  private var press: Runnable? = null
  private var velocity: VelocityTracker? = null
  private var motionToken = 0
  /** 正在播的那一次翻页方向。连点时先把这一页落定，不再把动画掐掉重来 */
  private var flying = 0
  private var lastTurnAt = 0L
  private var holes = emptyList<RectF>()
  private val clipPath = Path()
  @Volatile private var rasterToken = 0
  private val pool = ArrayList<Bitmap>()
  private var pageJsPosted = false
  private var styleGen = 0
  /** 这章排完后要落到的位置，0–1；小于 0 表示保持现在的页 */
  private var pendingAnchor = -1.0
  /** 目录或书签要落到的字符位置；小于 0 表示不用 */
  private var pendingOffset = -1
  private var pendingOffsetChapter = -1
  /** showAt 之后排版不能再用更早的进度把页盖回去 */
  private var landToken = 0
  private var fractionToken = 0
  private var selectKind = "new"
  private var barDown = -1
  /** -1 拖起点，1 拖终点，0 没有在拖 */
  private var handle = 0
  /** 按下把手时手指和把手所指那一行的距离，拖动时一直带着，字不会被手指挡住 */
  private var handleDx = 0f
  private var handleDy = 0f
  /** 长按选中后手指不抬接着拖：选区从长按的那个字伸到手指 */
  private var pressDrag = false
  private var pressAt = -1
  private val barHits = ArrayList<Pair<String, RectF>>()
  private val barText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
  private val barBg = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    setBackgroundColor(Color.TRANSPARENT)
    isClickable = true
  }

  fun bind(webView: WebView) {
    web = webView
  }

  fun bridge(): Bridge = Bridge()

  private fun place(l: Double, t: Double, w: Double, h: Double) {
    val webView = web ?: return
    val density = resources.displayMetrics.density
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

  private fun loadFace(name: String): Typeface {
    if (name == faceName) return face
    faceName = name
    val asset = when (name) {
      "kai" -> "fonts/kai.ttf"
      "serif" -> "fonts/serif.ttf"
      else -> ""
    }
    face = if (asset.isEmpty()) Typeface.SERIF else try {
      Typeface.createFromAsset(context.assets, asset)
    } catch (_: Exception) {
      Typeface.SERIF
    }
    return face
  }

  private fun applyStyle(bgHex: String, fgHex: String, sizePx: Double, lead: Double, margin: Double, animName: String, fontName: String) {
    val density = resources.displayMetrics.density
    val nextBg = parseColor(bgHex, Color.WHITE)
    val nextFg = parseColor(fgHex, Color.BLACK)
    val nextSize = (sizePx * density).toFloat().coerceAtLeast(8f)
    val nextLead = lead.toFloat().coerceIn(1.1f, 2.8f)
    val nextMargin = margin.toFloat().coerceIn(0.02f, 0.2f)
    if (nextBg == bg && nextFg == fg && nextSize == textPx && nextLead == leading && nextMargin == marginFrac && animName == anim && fontName == faceName) return
    bg = nextBg
    fg = nextFg
    textPx = nextSize
    leading = nextLead
    marginFrac = nextMargin
    anim = animName
    loadFace(fontName)
    setBackgroundColor(Color.TRANSPARENT)
    keepScrollSpot()
    rasterToken++
    styleGen++
    laid.clear()
    dropShots()
    clearPool()
    if (width > 0 && texts.containsKey(chapter)) layoutChapter(chapter, styleGen)
  }

  /** 同一代排版还在做时不要重开。点按章末会反复调用，重开就把没排完的下一章取消掉，翻页就停住 */
  private val flightGen = HashMap<Int, Int>()

  private fun layoutChapter(index: Int, gen: Int, restart: Boolean = false) {
    val blocks = texts[index] ?: return
    val contentW = contentWidth()
    val contentH = contentHeight()
    if (contentW <= 1 || contentH <= 1 || gen != styleGen) return
    if (!restart && flightGen[index] == gen) return
    flightGen[index] = gen
    val ticket = (layoutTicket[index] ?: 0) + 1
    layoutTicket[index] = ticket
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = fg
      textSize = textPx
      typeface = face
    }
    val size = textPx
    layoutHandler.post {
      val built = buildLaid(blocks, paint, contentW, contentH, size, gen)
      main.post publish@{
        if (layoutTicket[index] != ticket || gen != styleGen) return@publish
        if (flightGen[index] == gen) flightGen.remove(index)
        publishLaid(index, built)
      }
    }
  }

  private fun publishLaid(index: Int, built: Laid) {
    // 图到了、这一章重排时，屏幕顶上那一行不能被上面变高的图顶走
    if (scrollMode && index == chapter && scrollKeep == null) laid[index]?.let { scrollKeep = spotIn(it, scrollY) }
    laid[index] = built
    textKeys[index]?.let { laidKeys[index] = it }
    markCache.remove(index)
    if (index == chapter) {
      placeChapter(index, built)
      rasterAroundSoon(forceChapter = index)
      invalidate()
      reportPage()
      warmEdges()
    } else if (scrollMode) {
      invalidate()
    } else if (!landPending(index) && (nextOf[chapter] == index || prevOf[chapter] == index)) {
      rasterAroundSoon(forceChapter = index)
    }
  }

  /** 排版还在时不要清掉旧页。新的一版好了再换上 */
  private fun placeChapter(index: Int, book: Laid, consumeAnchor: Boolean = true) {
    if (index != chapter) return
    val offsetWins = pendingOffset >= 0 && pendingOffsetChapter == index && landToken != fractionToken
    if (offsetWins) {
      page = pageForOffset(book, pendingOffset)
      if (scrollMode) scrollY = yOfOffset(book, pendingOffset)
      if (consumeAnchor) pendingAnchor = -1.0
    } else if (pendingAnchor >= 0 && fractionToken == landToken) {
      val count = book.pages.size.coerceAtLeast(1)
      val span = (count - 1).coerceAtLeast(0)
      page = kotlin.math.floor(pendingAnchor * span).toInt().coerceIn(0, span)
      if (scrollMode) scrollY = (pendingAnchor * (spanOf(book) - height)).toFloat().coerceAtLeast(0f)
      if (consumeAnchor) pendingAnchor = -1.0
    } else if (scrollMode) {
      scrollKeep?.let { (at, dy) -> scrollY = yOfOffset(book, at) + dy }
    }
    if (scrollMode) {
      scrollKeep = null
      scrollY = scrollY.coerceIn(minScroll(), maxScroll())
    }
    if (selA >= 0) {
      val found = book.pages.indexOfFirst { items ->
        items.any { item ->
          val n = item.charCount()
          n > 0 && selA >= item.origin && selA < item.origin + n
        }
      }
      if (found >= 0) page = found
    }
    page = page.coerceIn(0, (book.pages.size - 1).coerceAtLeast(0))
  }

  private fun buildLaid(blocks: List<Block>, paint: TextPaint, contentW: Int, contentH: Int, textSize: Float, gen: Int): Laid {
    val pages = ArrayList<MutableList<Placed>>()
    var current = ArrayList<Placed>()
    var y = 0
    val plain = StringBuilder()
    val bodyGap = (textSize * 0.55f).roundToInt().coerceAtLeast(3)
    val headBefore = (textSize * 1.3f).roundToInt().coerceAtLeast(4)
    val headAfter = (textSize * 1.2f).roundToInt().coerceAtLeast(3)
    val lineH = (textSize * leading).roundToInt().coerceAtLeast(1)
    val density = resources.displayMetrics.density
    var placedText = false

    fun flush() {
      if (current.isNotEmpty()) pages.add(current)
      current = ArrayList()
      y = 0
    }

    for (block in blocks) {
      val image = block.image
      if (image != null && !image.isRecycled) {
        val (w, h) = imageBox(image, contentW, contentH, density)
        if (y > 0 && y + h > contentH) flush()
        current.add(Placed(null, null, 0, 0, image, h, y, 0, left = ((contentW - w) / 2).coerceAtLeast(0), imageWidth = w))
        y += h + bodyGap
        if (y >= contentH) flush()
        continue
      }
      if (block.runs.isEmpty()) continue
      val origin = plain.length
      val body = if (!block.heading && !block.pre && block.align == ALIGN_JUSTIFY) makeBody(block, paint, contentW) else null
      val layout = if (body == null) makeLayout(block, paint, contentW) else null
      // 正文记原字（标题、居中段画的是换过标点的字，长度一样），选字、划线才能和网页里的原文对上
      val text = body?.text ?: if (layout != null) block.runs.joinToString("") { it.text } else ""
      if (text.isEmpty()) continue
      plain.append(text)
      if (plain.isEmpty() || plain[plain.lastIndex] != '\n') plain.append('\n')
      val count = body?.lines?.size ?: layout?.lineCount ?: 0
      if (count == 0) continue
      fun topOf(line: Int) = body?.lines?.get(line)?.top ?: layout!!.getLineTop(line)
      fun bottomOf(line: Int) = body?.lines?.get(line)?.bottom ?: layout!!.getLineBottom(line)
      if (block.heading) {
        val headH = bottomOf(count - 1) - topOf(0)
        if (!placedText && pages.isEmpty() && y == 0) {
          // 章首的标题往下让一点，像书里新起一章
          y += (textSize * if (block.level <= 2) 2f else 1.2f).roundToInt()
        } else if (y > 0) {
          y += (headBefore - bodyGap).coerceAtLeast(0)
          // 标题不单独留在页底，下面至少还要放得下两行正文
          if (y + headH + headAfter + lineH * 2 > contentH) flush()
        }
      }
      placedText = true
      var line = 0
      var guard = 0
      while (line < count && guard++ < count + 5) {
        if (y > 0 && contentH - y < textSize) {
          flush()
          continue
        }
        var end = line
        val usable = (contentH - y).coerceAtLeast(1)
        while (end + 1 < count && bottomOf(end + 1) - topOf(line) <= usable) end++
        val sliceH = (bottomOf(end) - topOf(line)).coerceAtLeast(1)
        if (y > 0 && sliceH > contentH - y) {
          flush()
          continue
        }
        current.add(Placed(layout, body, line, end, null, sliceH, y, origin))
        y += sliceH
        line = end + 1
      }
      y += if (block.heading) headAfter else bodyGap
      if (y >= contentH) flush()
    }
    flush()
    if (pages.isEmpty()) pages.add(ArrayList())
    // 整页只有一张图（插图页、分部页）时上下居中，不贴在页顶
    // 上下滚动时页高是个极大的数，居中会把图推到几千万像素以外，前面全是空白
    val tall = contentH > 1_000_000
    for (p in pages.indices) {
      if (tall) break
      val only = pages[p].singleOrNull() ?: continue
      if (only.image == null || only.height >= contentH) continue
      pages[p] = mutableListOf(Placed(null, null, 0, 0, only.image, only.height, (contentH - only.height) / 2, only.origin, only.left, only.imageWidth))
    }
    return Laid(pages, plain.toString(), contentW, contentH, gen)
  }

  private fun makeLayout(block: Block, paint: TextPaint, width: Int): StaticLayout {
    val span = SpannableStringBuilder()
    for (run in block.runs) {
      val start = span.length
      span.append(horizontalText(run.text))
      val style = when {
        run.bold && run.italic -> Typeface.BOLD_ITALIC
        run.bold -> Typeface.BOLD
        run.italic -> Typeface.ITALIC
        else -> 0
      }
      if (style != 0) span.setSpan(StyleSpan(style), start, span.length, 0)
    }
    if (block.heading && span.isNotEmpty()) span.setSpan(RelativeSizeSpan(headingScale(block.level)), 0, span.length, 0)
    if (span.isEmpty()) span.append(" ")
    val alignment = when (block.align) {
      ALIGN_CENTER -> Layout.Alignment.ALIGN_CENTER
      ALIGN_RIGHT -> Layout.Alignment.ALIGN_OPPOSITE
      else -> Layout.Alignment.ALIGN_NORMAL
    }
    return StaticLayout.Builder.obtain(span, 0, span.length, paint, width)
      .setAlignment(alignment)
      .setLineSpacing(0f, if (block.heading) minOf(leading, 1.4f) else leading)
      .setIncludePad(false)
      // 标题折行时两行差不多长，不要第二行只剩一两个字
      .setBreakStrategy(if (block.heading) Layout.BREAK_STRATEGY_BALANCED else Layout.BREAK_STRATEGY_SIMPLE)
      .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
      .build()
  }

  private fun headingScale(level: Int): Float = when (level) {
    1 -> 1.5f
    2 -> 1.35f
    3 -> 1.22f
    4 -> 1.12f
    else -> 1.05f
  }

  /**
   * 普通段落的行盒。中文之间可以断，行首不放收口标点，行尾不放开口标点。
   * 非末行先把标点压到一半宽，再把空隙匀进字距，字距不超过 0.25em。末行不撑满。
   * 段首缩进只加在这一段的第一行。
   */
  private fun makeBody(block: Block, paint: TextPaint, width: Int): BodyText {
    val regular = TextPaint(paint)
    val bold = styledPaint(paint, Typeface.BOLD)
    val italic = styledPaint(paint, Typeface.ITALIC)
    val boldItalic = styledPaint(paint, Typeface.BOLD_ITALIC)
    val text = StringBuilder()
    val glyphs = ArrayList<RawGlyph>()
    val breaks = ArrayList<Int>()
    var seenInk = false
    for (run in block.runs) {
      val face = when {
        run.bold && run.italic -> boldItalic
        run.bold -> bold
        run.italic -> italic
        else -> regular
      }
      val icon = run.icon
      if (icon != null && !icon.isRecycled && run.text.isEmpty()) {
        // 行内小图按一个字高排在字里，不占字符，后面的字照旧数下标
        val h = paint.textSize
        val w = (h * icon.width / icon.height.coerceAtLeast(1)).coerceIn(1f, width.toFloat())
        glyphs.add(RawGlyph(text.length, "", w, w, run.bold, run.italic, icon))
        seenInk = true
        continue
      }
      var i = 0
      while (i < run.text.length) {
        val cp = run.text.codePointAt(i)
        val n = Character.charCount(cp)
        if (cp == '\n'.code) {
          breaks.add(text.length)
          text.append('\n')
          i += n
          continue
        }
        val s = run.text.substring(i, i + n)
        // 竖排专用标点横着排是歪的，按横排标点量宽、画字；正文里留原字，字符偏移不变
        val shown = horizontalForm(s)
        val w = face.measureText(shown).coerceAtLeast(0f)
        // 段首书里自带的空格（常见两个全角空格）不占宽度，缩进统一由排版加，不会缩进两次
        val lead = !seenInk && isSpace(shown)
        if (!isSpace(shown)) seenInk = true
        glyphs.add(RawGlyph(text.length, shown, if (lead) 0f else w, if (lead) 0f else w, run.bold, run.italic))
        text.append(s)
        i += n
      }
    }
    // 相邻的两个全角标点（如“。”」“，「”）挤掉一半，其余标点保持全宽
    for (k in 0 until glyphs.size - 1) {
      val a = glyphs[k]
      val b = glyphs[k + 1]
      if (!isSqueeze(a.text) || !isSqueeze(b.text) || !isWide(a.text) || !isWide(b.text)) continue
      if (isClosing(a.text) && a.width >= a.full) a.width = a.full * 0.5f
      else if (isOpening(b.text) && b.width >= b.full) b.width = b.full * 0.5f
    }
    val fm = paint.fontMetrics
    val lineH = ((fm.descent - fm.ascent) * leading).roundToInt().coerceAtLeast(1)
    val baseline = -fm.ascent
    val indent = paint.textSize * 2f
    val gapCap = paint.textSize * 0.25f
    val lines = ArrayList<BodyLine>()
    var glyphAt = 0
    var produced = 0
    var cursor = 0
    while (cursor <= text.length) {
      val breakAt = breaks.firstOrNull { it >= cursor } ?: text.length
      val segEnd = glyphs.indexOfFirst { it.index >= breakAt }.let { if (it < 0) glyphs.size else it }
      val from = glyphAt
      if (from < segEnd || breakAt < text.length || from == glyphs.size && cursor < text.length) {
        val cuts = breakGlyphs(glyphs, from, segEnd, width.toFloat(), produced == 0, indent)
        var top = produced * lineH
        for (cut in cuts) {
          val hard = cut.hard || cut.to >= segEnd
          val placed = placeGlyphs(glyphs, cut.from, cut.to, hard, if (produced == 0) indent else 0f, width.toFloat(), gapCap)
          val start = glyphs.getOrNull(cut.from)?.index ?: cursor
          val end = if (hard && breakAt < text.length && cut.to >= segEnd) breakAt + 1 else glyphs.getOrNull(cut.to - 1)?.let { it.index + it.text.length } ?: start
          lines.add(BodyLine(start, end.coerceAtLeast(start), top, top + lineH, placed))
          top += lineH
          produced++
        }
        if (cuts.isEmpty() && breakAt < text.length) {
          val top = produced * lineH
          lines.add(BodyLine(breakAt, breakAt + 1, top, top + lineH, emptyList()))
          produced++
        }
      }
      if (breakAt >= text.length) break
      glyphAt = segEnd
      cursor = breakAt + 1
    }
    if (lines.isEmpty() && text.isNotEmpty()) {
      lines.add(BodyLine(0, text.length, 0, lineH, emptyList()))
    }
    return BodyText(text.toString(), lines, baseline, regular, bold, italic, boldItalic)
  }

  private class Cut(val from: Int, val to: Int, val hard: Boolean)

  /** 在这一段里断行。to 不含尾部空格；空格算进行尾，避免下一行以空格开头 */
  private fun breakGlyphs(
    glyphs: List<RawGlyph>,
    from: Int,
    to: Int,
    width: Float,
    indentFirst: Boolean,
    indent: Float,
  ): List<Cut> {
    val out = ArrayList<Cut>()
    var i = from
    var first = indentFirst
    var guard = 0
    while (i < to && guard++ < to - from + 2) {
      val limit = (width - if (first) indent else 0f).coerceAtLeast(1f)
      var acc = 0f
      var j = i
      while (j < to) {
        val w = glyphs[j].width
        if (j > i && acc + w > limit) break
        acc += w
        j++
      }
      if (j < to) {
        var k = j
        while (k > i && !canBreakBefore(glyphs, k)) k--
        j = if (k <= i) {
          var forced = j.coerceAtLeast((i + 1).coerceAtMost(to))
          while (forced < to && isClosing(glyphs[forced].text)) forced++
          forced
        } else {
          k
        }
      }
      var end = j
      while (end < to && isSpace(glyphs[end].text)) end++
      if (end <= i) end = (i + 1).coerceAtMost(to)
      val hard = end >= to
      out.add(Cut(i, end, hard))
      i = end
      first = false
    }
    return out
  }

  private fun canBreakBefore(glyphs: List<RawGlyph>, index: Int): Boolean {
    if (index <= 0 || index >= glyphs.size) return false
    val prev = glyphs[index - 1].text
    val next = glyphs[index].text
    if (isClosing(next)) return false
    if (isOpening(prev)) return false
    if (isWestern(prev) && isWestern(next)) return false
    return true
  }

  /**
   * 放下一行字。放不下（行尾带了不能落到行首的标点）时先挤压这一行的全角标点；
   * 非末行再两端对齐，空隙只匀在中文字之间和空格上，英文单词、网址里面不拉开。末行保持自然宽度
   */
  private fun placeGlyphs(
    glyphs: List<RawGlyph>,
    from: Int,
    to: Int,
    hard: Boolean,
    indent: Float,
    width: Float,
    gapCap: Float,
  ): List<Glyph> {
    var vis = to
    while (vis > from && isSpace(glyphs[vis - 1].text)) vis--
    val contentFrom = from
    val contentTo = if (vis > from) vis else to
    val trailingFrom = if (vis > from) vis else to
    val visible = contentTo - contentFrom
    val limit = (width - indent).coerceAtLeast(1f)
    val widths = FloatArray(visible)
    val shifts = FloatArray(visible)
    var used = 0f
    for (i in 0 until visible) {
      val g = glyphs[contentFrom + i]
      widths[i] = g.width
      if (g.width < g.full && isOpening(g.text)) shifts[i] = g.width - g.full
      used += g.width
    }
    if (used > limit) {
      var room = 0f
      for (i in 0 until visible) {
        val g = glyphs[contentFrom + i]
        if (isSqueeze(g.text) && isWide(g.text) && widths[i] >= g.full) room += g.full * 0.5f
      }
      if (room > 0f) {
        val k = ((used - limit) / room).coerceAtMost(1f)
        for (i in 0 until visible) {
          val g = glyphs[contentFrom + i]
          if (!isSqueeze(g.text) || !isWide(g.text) || widths[i] < g.full) continue
          val cut = g.full * 0.5f * k
          widths[i] -= cut
          used -= cut
          if (isOpening(g.text)) shifts[i] -= cut
        }
      }
    }
    val slots = BooleanArray(visible)
    var gap = 0f
    if (!hard && visible > 1) {
      var count = 0
      for (i in 0 until visible - 1) {
        val a = glyphs[contentFrom + i]
        val b = glyphs[contentFrom + i + 1]
        val ok = a.width > 0f && (isSpace(a.text) || isSpace(b.text) || isCjk(a.text) || isCjk(b.text))
        slots[i] = ok
        if (ok) count++
      }
      val remain = limit - used
      if (remain > 0f && count > 0) gap = minOf(gapCap, remain / count)
    }
    val out = ArrayList<Glyph>(to - from)
    var x = indent
    for (i in 0 until visible) {
      val g = glyphs[contentFrom + i]
      out.add(Glyph(g.index, g.text, x, widths[i], g.bold, g.italic, shifts[i], g.icon))
      x += widths[i]
      if (slots[i]) x += gap
    }
    for (i in trailingFrom until to) {
      val g = glyphs[i]
      out.add(Glyph(g.index, g.text, x, g.width, g.bold, g.italic, 0f, g.icon))
      x += g.width
    }
    return out
  }

  private fun styledPaint(base: TextPaint, style: Int): TextPaint {
    return TextPaint(base).apply {
      typeface = Typeface.create(base.typeface ?: Typeface.DEFAULT, style)
    }
  }

  private fun isSqueeze(text: String) = mark(text, SQUEEZE)
  private fun isOpening(text: String) = mark(text, OPENING)
  private fun isClosing(text: String) = mark(text, CLOSING)

  private fun isSpace(text: String): Boolean {
    if (text.length != 1) return false
    val c = text[0]
    return c == ' ' || c == '\t' || c == '\u3000' || c == '\u00A0'
  }

  /** 竖排专用标点换成横排标点，一个字换一个字（和网页里的 horizontalPunct 一致） */
  private fun horizontalForm(s: String): String {
    if (s.length != 1) return s
    val i = VERTICAL_FORMS.indexOf(s[0])
    return if (i < 0) s else HORIZONTAL_FORMS[i].toString()
  }

  private fun horizontalText(text: String): String {
    if (text.none { VERTICAL_FORMS.indexOf(it) >= 0 }) return text
    val out = StringBuilder(text.length)
    for (c in text) {
      val i = VERTICAL_FORMS.indexOf(c)
      out.append(if (i < 0) c else HORIZONTAL_FORMS[i])
    }
    return out.toString()
  }

  /** 全角字符（中日韩文字、全角标点和弯引号） */
  private fun isWide(text: String): Boolean = text.isNotEmpty() && text.codePointAt(0) >= 0x2000

  private fun isCjk(text: String): Boolean {
    if (text.isEmpty()) return false
    val cp = text.codePointAt(0)
    return cp in 0x2E80..0x9FFF || cp in 0xAC00..0xD7AF || cp in 0xF900..0xFAFF || cp in 0xFE30..0xFE4F || cp in 0xFF00..0xFFEF || cp in 0x20000..0x2FFFF
  }

  private fun isWestern(text: String): Boolean {
    if (text.isEmpty()) return false
    val cp = text.codePointAt(0)
    if (cp in '0'.code..'9'.code) return true
    if (cp in 'A'.code..'Z'.code || cp in 'a'.code..'z'.code) return true
    return cp in 0x00C0..0x024F
  }

  private fun mark(text: String, set: String): Boolean {
    if (text.length != 1) return false
    return set.indexOf(text[0]) >= 0
  }

  /**
   * 图按书里的大小（CSS 像素乘屏幕密度）放，宽不超过正文，高不超过一页，保持比例。
   * 小图标、花饰不再被拉满整行
   */
  private fun imageBox(bmp: Bitmap, contentW: Int, contentH: Int, density: Float): Pair<Int, Int> {
    val bw = bmp.width.coerceAtLeast(1).toFloat()
    val bh = bmp.height.coerceAtLeast(1).toFloat()
    var w = minOf(contentW.toFloat(), bw * density)
    var h = bh * w / bw
    val maxH = contentH * 0.92f
    if (h > maxH) {
      w *= maxH / h
      h = maxH
    }
    return w.roundToInt().coerceAtLeast(1) to h.roundToInt().coerceAtLeast(1)
  }

  private fun contentWidth(): Int {
    val pad = (width * marginFrac).roundToInt()
    return (width - pad * 2).coerceAtLeast(1)
  }

  private fun padTop(): Float = PAD_TOP_DP * resources.displayMetrics.density

  private fun contentHeight(): Int {
    if (scrollMode) return 50_000_000
    val density = resources.displayMetrics.density
    return (height - padTop() - PAD_BOTTOM_DP * density).roundToInt().coerceAtLeast(1)
  }

  private var rasterPosted = false
  private var rasterForceAll = false
  private val rasterForceChapters = HashSet<Int>()

  /** 翻页这一帧先用已经画好的图。缺的邻页等这一帧画完再补，避免手指松开时卡住 */
  private fun rasterAroundSoon(forceAll: Boolean = false, forceChapter: Int = -1) {
    if (forceAll) rasterForceAll = true
    if (forceChapter >= 0) rasterForceChapters.add(forceChapter)
    if (rasterPosted) return
    rasterPosted = true
    main.post {
      rasterPosted = false
      val all = rasterForceAll
      val chapters = rasterForceChapters.toHashSet()
      rasterForceAll = false
      rasterForceChapters.clear()
      rasterAround(all, chapters)
    }
  }

  private fun wantedKeys(): HashSet<Key> {
    val keep = HashSet<Key>()
    fun add(c: Int, p: Int) {
      val book = laid[c] ?: return
      if (p !in book.pages.indices) return
      keep.add(Key(c, p, book.gen, book.width, book.height))
    }
    add(chapter, page)
    add(chapter, page - 1)
    add(chapter, page + 1)
    add(chapter, page - 2)
    add(chapter, page + 2)
    val prev = prevOf[chapter]
    val next = nextOf[chapter]
    if (prev != null) add(prev, (laid[prev]?.pages?.size ?: 0) - 1)
    if (next != null) add(next, 0)
    return keep
  }

  /**
   * 位图在排版线程画，主线程只换图。
   * force 时重画已有的页（划线变了）。选中高亮不进位图，直接画在上面。
   */
  private fun rasterAround(forceAll: Boolean = false, forceChapters: Set<Int> = emptySet()) {
    if (scrollMode) return
    if (laid[chapter] == null || width <= 1 || height <= 1) return
    val wanted = wantedKeys()
    val jobs = ArrayList<PageDraw>()
    for (key in wanted) {
      val redraw = forceAll || key.chapter in forceChapters
      if (!redraw && shots[key] != null) continue
      val book = laid[key.chapter] ?: continue
      jobs.add(PageDraw(key, book, key.page))
    }
    if (jobs.isEmpty()) {
      pruneShots(wanted)
      return
    }
    val token = ++rasterToken
    val viewW = width
    val viewH = height
    val color = bg
    val margin = marginFrac
    val padY = padTop()
    val markSnap = marks
    val densityDpi = resources.displayMetrics.densityDpi
    layoutHandler.postAtFrontOfQueue {
      if (token != rasterToken) return@postAtFrontOfQueue
      val made = ArrayList<Pair<Key, Bitmap>>(jobs.size)
      val imagePaint = Paint(Paint.FILTER_BITMAP_FLAG)
      val highlight = Paint().apply { this.color = Color.argb(96, 250, 204, 70) }
      for (job in jobs) {
        if (token != rasterToken) {
          made.forEach { releaseBitmap(it.second) }
          return@postAtFrontOfQueue
        }
        val ranges = markSnap.filter { it.section == job.key.chapter }.map { it.start to it.end }
        made.add(job.key to drawPage(job.book, job.page, viewW, viewH, color, margin, padY, ranges, imagePaint, highlight, densityDpi))
      }
      main.post swap@{
        if (token != rasterToken) {
          made.forEach { releaseBitmap(it.second) }
          return@swap
        }
        for ((key, bmp) in made) {
          val book = laid[key.chapter]
          val still = book != null && key.page in book.pages.indices && key.gen == book.gen && key.width == book.width && key.height == book.height
          if (!still) {
            releaseBitmap(bmp)
            continue
          }
          releaseBitmap(shots.put(key, bmp))
        }
        pruneShots(wantedKeys())
        invalidate()
      }
    }
  }

  private fun pruneShots(keep: Set<Key>) {
    val dead = shots.keys.filter { it !in keep }
    for (key in dead) releaseBitmap(shots.remove(key))
  }

  private fun drawPage(
    book: Laid,
    pageIndex: Int,
    viewW: Int,
    viewH: Int,
    color: Int,
    margin: Float,
    padY: Float,
    marks: List<Pair<Int, Int>>,
    imagePaint: Paint,
    highlight: Paint,
    densityDpi: Int,
  ): Bitmap {
    val bmp = obtainBitmap(viewW, viewH, densityDpi)
    val canvas = Canvas(bmp)
    canvas.drawColor(color)
    drawContent(canvas, book, pageIndex, viewW * margin, padY, marks, imagePaint, highlight)
    return bmp
  }

  /** 一页的字和图。位图和屏幕上的缺图补画都走这里 */
  private fun drawContent(
    canvas: Canvas,
    book: Laid,
    pageIndex: Int,
    padX: Float,
    padY: Float,
    marks: List<Pair<Int, Int>>,
    imagePaint: Paint,
    highlight: Paint,
  ) {
    val items = book.pages.getOrNull(pageIndex) ?: return
    for (item in items) {
      val image = item.image
      if (image != null && !image.isRecycled) {
        val w = if (item.imageWidth > 0) item.imageWidth else book.width
        val dst = RectF(padX + item.left, padY + item.top, padX + item.left + w, padY + item.top + item.height)
        canvas.drawBitmap(image, null, dst, imagePaint)
        continue
      }
      val body = item.body
      if (body != null) {
        drawMarks(canvas, item, marks, padX, padY, highlight)
        drawBody(canvas, item, padX, padY)
        continue
      }
      val layout = item.layout ?: continue
      drawMarks(canvas, item, marks, padX, padY, highlight)
      val localTop = layout.getLineTop(item.line0)
      canvas.save()
      canvas.translate(padX, padY + item.top - localTop)
      canvas.clipRect(0f, localTop.toFloat(), book.width.toFloat(), (localTop + item.height).toFloat())
      layout.draw(canvas)
      canvas.restore()
    }
  }

  private val iconPaint = Paint(Paint.FILTER_BITMAP_FLAG)

  private fun drawBody(canvas: Canvas, item: Placed, padX: Float, padY: Float) {
    val body = item.body ?: return
    if (item.line0 > item.line1 || body.lines.isEmpty()) return
    val shift = body.lines[item.line0].top
    for (i in item.line0..item.line1) {
      val line = body.lines.getOrNull(i) ?: continue
      val baseline = padY + item.top + (line.top - shift) + body.baseline
      for (g in line.glyphs) {
        val icon = g.icon
        if (icon != null) {
          if (icon.isRecycled) continue
          // 和字一样高，底边落在字的下沿附近
          val size = body.regular.textSize
          val top = baseline - size * 0.86f
          canvas.drawBitmap(icon, null, RectF(padX + g.x, top, padX + g.x + g.width, top + size), iconPaint)
          continue
        }
        val face = when {
          g.bold && g.italic -> body.boldItalic
          g.bold -> body.bold
          g.italic -> body.italic
          else -> body.regular
        }
        canvas.drawText(g.text, padX + g.x + g.shift, baseline, face)
      }
    }
  }

  private fun obtainBitmap(w: Int, h: Int, densityDpi: Int): Bitmap {
    synchronized(pool) {
      val i = pool.indexOfLast { !it.isRecycled && it.width == w && it.height == h }
      if (i >= 0) return pool.removeAt(i)
    }
    return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { it.density = densityDpi }
  }

  private fun releaseBitmap(bmp: Bitmap?) {
    if (bmp == null || bmp.isRecycled) return
    synchronized(pool) {
      val sameSize = bmp.width == width && bmp.height == height
      if (!sameSize || pool.size >= 4) bmp.recycle() else pool.add(bmp)
    }
  }

  private fun clearPool() {
    synchronized(pool) {
      for (bmp in pool) if (!bmp.isRecycled) bmp.recycle()
      pool.clear()
    }
  }

  private fun drawMarks(canvas: Canvas, item: Placed, marks: List<Pair<Int, Int>>, padX: Float, padY: Float, paint: Paint) {
    val n = item.charCount()
    if (n <= 0) return
    for ((a, b) in marks) {
      val start = (a - item.origin).coerceAtLeast(0)
      val end = (b - item.origin).coerceAtMost(n)
      if (end <= start) continue
      val lineLo = item.lineForOffset(start).coerceAtLeast(item.line0)
      val lineHi = item.lineForOffset(end - 1).coerceAtMost(item.line1)
      if (lineHi < item.line0 || lineLo > item.line1) continue
      for (line in lineLo..lineHi) {
        val from = if (line == item.lineForOffset(start)) start else item.lineStart(line)
        val to = if (line == item.lineForOffset(end - 1)) end else item.lineEnd(line)
        val left = item.xOnLine(line, from)
        val right = item.xOnLine(line, to)
        val top = padY + item.top + item.lineTop(line) - item.lineTop(item.line0)
        val bottom = padY + item.top + item.lineBottom(line) - item.lineTop(item.line0)
        canvas.drawRect(padX + minOf(left, right), top, padX + maxOf(left, right), bottom, paint)
      }
    }
  }

  private fun shot(c: Int, p: Int): Bitmap? {
    val book = laid[c] ?: return null
    if (p !in book.pages.indices) return null
    val exact = shots[Key(c, p, book.gen, book.width, book.height)]
    if (exact != null && !exact.isRecycled) return exact
    return shots.entries.firstOrNull { (key, bmp) ->
      !bmp.isRecycled && key.chapter == c && key.page == p && key.width == book.width && key.height == book.height
    }?.value
  }

  private fun dropShots() {
    for (bmp in shots.values) releaseBitmap(bmp)
    shots.clear()
  }

  /** 插图和正在画的页用同一条线程回收，避免画到一半被回收 */
  private fun recycleBlocks(list: List<Block>?) {
    if (list.isNullOrEmpty()) return
    layoutHandler.post {
      list.forEach { block ->
        block.image?.let { if (!it.isRecycled) it.recycle() }
        for (run in block.runs) run.icon?.let { if (!it.isRecycled) it.recycle() }
      }
    }
  }

  private fun pageCount(): Int = laid[chapter]?.pages?.size ?: 0

  /** 字符落在哪一页。同一段跨页时各片共用段首下标，要按行来判 */
  private fun pageForOffset(book: Laid, offset: Int): Int {
    if (offset <= 0) return 0
    var nearest = 0
    for (i in book.pages.indices) {
      for (item in book.pages[i]) {
        val n = item.charCount()
        if (n <= 0) continue
        if (item.origin <= offset) nearest = i
        val at = offset - item.origin
        if (at < 0 || at >= n) continue
        val line = item.lineForOffset(at)
        if (line in item.line0..item.line1) return i
      }
    }
    return nearest
  }

  override fun onDraw(canvas: Canvas) {
    val checkpoint = canvas.save()
    if (holes.isNotEmpty()) {
      clipPath.rewind()
      clipPath.fillType = Path.FillType.EVEN_ODD
      clipPath.addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
      for (hole in holes) clipPath.addRect(hole, Path.Direction.CCW)
      canvas.clipPath(clipPath)
    }
    canvas.drawColor(bg)
    if (scrollMode) {
      drawScroll(canvas)
      canvas.restoreToCount(checkpoint)
      drawBar(canvas)
      return
    }
    val w = width.toFloat()
    val goingNext = offset < 0f
    val neighbor = if (goingNext) neighborSlot(1) else if (offset > 0f) neighborSlot(-1) else null
    when (anim) {
      "cover" -> if (goingNext) {
        if (neighbor != null) paintSlot(canvas, neighbor.first, neighbor.second, 0f, 255)
        paintSlot(canvas, chapter, page, offset, 255)
      } else {
        paintSlot(canvas, chapter, page, 0f, 255)
        if (neighbor != null) paintSlot(canvas, neighbor.first, neighbor.second, offset - w, 255)
      }
      "fade" -> {
        paintSlot(canvas, chapter, page, 0f, 255)
        if (neighbor != null && w > 0f) {
          val alpha = (abs(offset) / w * 255f).roundToInt().coerceIn(0, 255)
          paintSlot(canvas, neighbor.first, neighbor.second, 0f, alpha)
        }
      }
      "none" -> paintSlot(canvas, chapter, page, 0f, 255)
      else -> {
        paintSlot(canvas, chapter, page, offset, 255)
        if (neighbor != null) {
          val nx = if (goingNext) offset + w else offset - w
          paintSlot(canvas, neighbor.first, neighbor.second, nx, 255)
        }
      }
    }
    drawSelection(canvas)
    canvas.restoreToCount(checkpoint)
    drawBar(canvas)
  }

  /** 章内用相邻页，章末用链接上的那一章。还没分页就没有这一格 */
  private fun neighborSlot(dir: Int): Pair<Int, Int>? {
    val count = pageCount()
    val target = page + dir
    if (target in 0 until count) return chapter to target
    val other = linked(dir)
    if (other < 0) return null
    val book = laid[other] ?: return null
    val p = if (dir > 0) 0 else book.pages.lastIndex
    if (p !in book.pages.indices) return null
    return other to p
  }

  /**
   * 有位图就贴位图。没有位图但这一页已经排好时，直接把字画上来，位移和位图一样。
   * 章还没分页时什么都不画，底下仍是底色。
   */
  private fun paintSlot(canvas: Canvas, chapterIndex: Int, pageIndex: Int, dx: Float, alpha: Int) {
    if (alpha <= 0) return
    val bmp = shot(chapterIndex, pageIndex)
    if (bmp != null) {
      val previous = bitmapPaint.alpha
      bitmapPaint.alpha = alpha
      canvas.drawBitmap(bmp, dx, 0f, bitmapPaint)
      bitmapPaint.alpha = previous
      return
    }
    val book = laid[chapterIndex] ?: return
    if (pageIndex !in book.pages.indices) return
    val checkpoint = canvas.save()
    canvas.translate(dx, 0f)
    if (alpha < 255) canvas.saveLayerAlpha(0f, 0f, width.toFloat(), height.toFloat(), alpha)
    pageFill.color = bg
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), pageFill)
    val padX = width * marginFrac
    val padY = padTop()
    drawContent(canvas, book, pageIndex, padX, padY, marksFor(chapterIndex), contentImagePaint, pageHighlight)
    canvas.restoreToCount(checkpoint)
  }

  /** 这一章已经记下的划线区间。引文没变就不再重算 */
  private fun marksFor(index: Int): List<Pair<Int, Int>> {
    if (cachedQuoteStamp != quoteStamp) {
      markCache.clear()
      cachedQuoteStamp = quoteStamp
    }
    val cached = markCache[index]
    if (cached != null) return cached
    val found = marks.filter { it.section == index }.map { it.start to it.end }
    markCache[index] = found
    return found
  }

  private fun barItems(): List<Pair<String, String>> {
    return if (selectKind == "anno") listOf(
      "note" to "写想法",
      "copy" to "复制",
      "ai" to "问 AI",
      "delete" to "删除",
    ) else listOf(
      "mark" to "划线",
      "note" to "写想法",
      "copy" to "复制",
      "ai" to "问 AI",
    )
  }

  /** 选区菜单画在书页上面，不靠网页那一层，免得被页图挡住 */
  private fun prepareBar() {
    barHits.clear()
    // 拖把手时先收起菜单，松手再按新的选区放
    if (!selecting || handle != 0) return
    val box = selectionBounds() ?: return
    val items = barItems()
    val density = resources.displayMetrics.density
    barText.textSize = 13f * density
    barText.color = bg
    val padX = 12f * density
    val barH = 40f * density
    var total = 0f
    val widths = items.map { (_, label) ->
      val w = barText.measureText(label) + padX * 2
      total += w
      w
    }
    var left = (box.centerX() - total / 2f).coerceIn(8f * density, (width - total - 8f * density).coerceAtLeast(8f * density))
    var top = box.top - barH - 14f * density
    // 上面放不下就放到选区下面，让开把手
    if (top < 8f * density) top = box.bottom + (HANDLE_DP * 2 + 14f) * density
    if (top + barH > height - 8f * density) top = (height - barH - 8f * density).coerceAtLeast(8f * density)
    for (i in items.indices) {
      val right = left + widths[i]
      barHits.add(items[i].first to RectF(left, top, right, top + barH))
      left = right
    }
  }

  private fun barButton(x: Float, y: Float): Int {
    prepareBar()
    val exact = barHits.indexOfFirst { it.second.contains(x, y) }
    if (exact >= 0) return exact
    val slop = 16f * resources.displayMetrics.density
    return barHits.indexOfFirst {
      val hit = RectF(it.second)
      hit.inset(-slop, -slop * 1.5f)
      hit.contains(x, y)
    }
  }

  private fun drawBar(canvas: Canvas) {
    prepareBar()
    if (barHits.isEmpty()) return
    val density = resources.displayMetrics.density
    val all = RectF(barHits.first().second)
    for (hit in barHits) all.union(hit.second)
    barBg.color = fg
    canvas.drawRoundRect(all, 10f * density, 10f * density, barBg)
    barText.color = bg
    val line = Paint().apply { color = Color.argb(40, Color.red(bg), Color.green(bg), Color.blue(bg)) }
    for (i in barHits.indices) {
      val rect = barHits[i].second
      val label = barItems()[i].second
      if (barHits[i].first == "delete") barText.color = Color.parseColor("#ff8a7a") else barText.color = bg
      val baseline = rect.centerY() - (barText.fontMetrics.ascent + barText.fontMetrics.descent) / 2f
      canvas.drawText(label, rect.centerX(), baseline, barText)
      if (i > 0) canvas.drawLine(rect.left, rect.top + 8f * density, rect.left, rect.bottom - 8f * density, line)
    }
  }

  /** 选中高亮画在位图上面，松手就能看见，不用整页重画 */
  private fun drawSelection(canvas: Canvas) {
    if (selA < 0 || selB <= selA) return
    val book = laid[chapter] ?: return
    val items = book.pages.getOrNull(page) ?: return
    val padX = width * marginFrac
    val padY = padTop()
    canvas.save()
    canvas.translate(offset, 0f)
    val marks = listOf(selA to selB)
    for (item in items) {
      if (item.hasText()) drawMarks(canvas, item, marks, padX, padY, markPaint)
    }
    if (!scrollMode) {
      val density = resources.displayMetrics.density
      for (edge in intArrayOf(-1, 1)) {
        val caret = caretAt(if (edge < 0) selA else selB, edge > 0) ?: continue
        canvas.drawRect(caret.left - density, caret.top, caret.left + density, caret.bottom, knobPaint)
        canvas.drawCircle(caret.left, caret.bottom + HANDLE_DP * density, HANDLE_DP * density, knobPaint)
      }
    }
    canvas.restore()
  }

  private val knobPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2f6fed") }

  /**
   * 选区一端在当前页上的位置：left 是这一端的横坐标，top、bottom 是那一行字的上下沿。
   * end 为假时是 offset 这个字的左边，为真时是 offset 前一个字的右边
   */
  private fun caretAt(offset: Int, end: Boolean): RectF? {
    val book = laid[chapter] ?: return null
    val items = book.pages.getOrNull(page) ?: return null
    val padX = width * marginFrac
    val padY = padTop()
    for (item in items) {
      val n = item.charCount()
      if (n <= 0) continue
      val local = (if (end) offset - 1 else offset) - item.origin
      if (local < 0 || local >= n) continue
      val line = item.lineForOffset(local)
      if (line < item.line0 || line > item.line1) continue
      val x = if (end) item.rightOf(line, local) else item.xOnLine(line, local)
      val top = padY + item.top + item.lineTop(line) - item.lineTop(item.line0)
      val bottom = padY + item.top + item.lineBottom(line) - item.lineTop(item.line0)
      // 行盒下面还有行距，把手贴着字的下沿，不要悬在行距里
      val textBottom = top + minOf(bottom - top, textPx * 1.3f)
      return RectF(padX + x, top, padX + x, textBottom)
    }
    return null
  }

  private fun linked(dir: Int): Int = (if (dir > 0) nextOf[chapter] else prevOf[chapter]) ?: -1

  private fun neighborReady(dir: Int): Boolean {
    val other = linked(dir)
    return other >= 0 && (laid[other] != null || texts.containsKey(other))
  }

  private fun ensureLaid(index: Int) {
    if (index >= 0 && laid[index] == null && texts.containsKey(index)) layoutChapter(index, styleGen)
  }

  /** 靠近章的两头时，邻章正文已经在手里就马上分页 */
  private fun warmEdges() {
    val pages = pageCount()
    if (pages <= 0) return
    if (page >= pages - 2) ensureLaid(linked(1))
    if (page <= 1) ensureLaid(linked(-1))
  }

  private fun canGo(dir: Int): Boolean {
    if (selecting) return false
    val count = pageCount()
    if (dir > 0 && page + 1 < count) return true
    if (dir < 0 && page > 0) return true
    return neighborReady(dir)
  }

  private fun holeAt(x: Float, y: Float): Boolean = holes.any { it.contains(x, y) }

  /**
   * 上下滚动把当前章和前后已经排好的章竖着接成一条来画，手指只改变滚动位置。
   * 章界滚过屏幕顶时只换当前章、换算 scrollY，画面不跳
   */
  private fun drawScroll(canvas: Canvas) {
    val book = laid[chapter] ?: return
    val padX = width * marginFrac
    val padY = padTop()
    val top = -scrollY
    drawFlow(canvas, chapter, book, top, padX, padY)
    var index = chapter
    var edge = top
    var guard = 0
    while (edge > 0f && guard++ < CHAIN_MAX) {
      val other = scrollNeighbor(index, -1)
      val prev = laid[other] ?: break
      edge -= spanOf(prev)
      drawFlow(canvas, other, prev, edge, padX, padY)
      index = other
    }
    index = chapter
    edge = top + spanOf(book)
    guard = 0
    while (edge < height && guard++ < CHAIN_MAX) {
      val other = scrollNeighbor(index, 1)
      val next = laid[other] ?: break
      drawFlow(canvas, other, next, edge, padX, padY)
      edge += spanOf(next)
      index = other
    }
    canvas.save()
    canvas.translate(0f, top)
    drawSelection(canvas)
    canvas.restore()
  }

  /** 一章的行盒，top 是这一章的顶在屏幕上的位置 */
  private fun drawFlow(canvas: Canvas, index: Int, book: Laid, top: Float, padX: Float, padY: Float) {
    val marks = marksFor(index)
    var base = 0
    for (items in book.pages) {
      for (item in items) {
        val y = top + base + item.top
        if (y + item.height < -80f || y > height + 80f) continue
        canvas.save()
        canvas.translate(0f, top + base)
        drawPlaced(canvas, book, item, padX, padY, marks)
        canvas.restore()
      }
      base += items.maxOfOrNull { it.top + it.height } ?: 0
    }
  }

  private fun drawPlaced(canvas: Canvas, book: Laid, item: Placed, padX: Float, padY: Float, marks: List<Pair<Int, Int>>) {
    val image = item.image
    if (image != null && !image.isRecycled) {
      val bookW = book.width.toFloat()
      val w = if (item.imageWidth > 0) item.imageWidth.toFloat() else bookW
      val dst = RectF(padX + item.left, padY + item.top, padX + item.left + w, padY + item.top + item.height)
      canvas.drawBitmap(image, null, dst, contentImagePaint)
      return
    }
    val body = item.body
    if (body != null) {
      drawMarks(canvas, item, marks, padX, padY, pageHighlight)
      drawBody(canvas, item, padX, padY)
      return
    }
    val layout = item.layout ?: return
    drawMarks(canvas, item, marks, padX, padY, pageHighlight)
    val localTop = layout.getLineTop(item.line0)
    canvas.save()
    canvas.translate(padX, padY + item.top - localTop)
    canvas.clipRect(0f, localTop.toFloat(), layout.width.toFloat(), (localTop + item.height).toFloat())
    layout.draw(canvas)
    canvas.restore()
  }

  /** 上下滚动里一章占多高，章末留一点空再接下一章 */
  private fun spanOf(book: Laid): Int = book.flow + (24f * resources.displayMetrics.density).roundToInt()

  private fun flowHeight(): Int = laid[chapter]?.let { spanOf(it) } ?: 0

  /** 能和 index 接在同一条滚动里的邻章：原生已经排好的。网页章、还没排好的不接 */
  private fun scrollNeighbor(index: Int, dir: Int): Int {
    val other = (if (dir > 0) nextOf[index] else prevOf[index]) ?: return -1
    if (webChapters.contains(other) || laid[other] == null) return -1
    return other
  }

  /** 从当前章往 dir 一直接下去，接上的最后一章 */
  private fun chainEnd(dir: Int): Int {
    var index = chapter
    repeat(CHAIN_MAX) {
      val other = scrollNeighbor(index, dir)
      if (other < 0) return index
      index = other
    }
    return index
  }

  /** 往上最多滚到哪：上面接着的章都能滚进来 */
  private fun minScroll(): Float {
    var index = chapter
    var up = 0
    repeat(CHAIN_MAX) {
      val other = scrollNeighbor(index, -1)
      val book = laid[other] ?: return -up.toFloat()
      up += spanOf(book)
      index = other
    }
    return -up.toFloat()
  }

  private fun maxScroll(): Float {
    var index = chapter
    var down = flowHeight()
    repeat(CHAIN_MAX) {
      val other = scrollNeighbor(index, 1)
      val book = laid[other] ?: return (down - height).coerceAtLeast(0).toFloat()
      down += spanOf(book)
      index = other
    }
    return (down - height).coerceAtLeast(0).toFloat()
  }

  /** 上下滚动挪 dy（往后读为正），返回实际挪了多少。到了接上的最后一章的头尾就停住 */
  private fun scrollByPx(dy: Float): Float {
    val before = scrollY
    scrollY = (scrollY + dy).coerceIn(minScroll(), maxScroll())
    val moved = scrollY - before
    if (!selecting) settleChapter()
    prepareScroll()
    return moved
  }

  /** 屏幕顶跨过章界时只换当前章，scrollY 跟着换算，画面不动 */
  private fun settleChapter() {
    var dir = 0
    var guard = 0
    while (guard++ < CHAIN_MAX) {
      val book = laid[chapter] ?: break
      val span = spanOf(book)
      if (scrollY >= span) {
        val other = scrollNeighbor(chapter, 1)
        if (other < 0) break
        scrollY -= span
        chapter = other
        dir = 1
      } else if (scrollY < 0f) {
        val other = scrollNeighbor(chapter, -1)
        val prev = laid[other] ?: break
        scrollY += spanOf(prev)
        chapter = other
        dir = -1
      } else break
    }
    if (dir == 0) return
    page = 0
    reportPage()
    callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($chapter,$dir)")
    warmEdges()
  }

  /** 离接上的最后一章的头尾不到几屏时，把再往外的那一章要过来排好，滑到那里不用停下来等 */
  private fun prepareScroll() {
    val ahead = height.coerceAtLeast(1) * 4
    if (maxScroll() - scrollY < ahead) prepareBeyond(1)
    if (scrollY - minScroll() < ahead) prepareBeyond(-1)
  }

  private fun prepareBeyond(dir: Int) {
    val last = chainEnd(dir)
    val other = (if (dir > 0) nextOf[last] else prevOf[last]) ?: -1
    if (other >= 0 && (webChapters.contains(other) || laid[other] != null)) return
    if (other >= 0 && texts.containsKey(other)) {
      ensureLaid(other)
      return
    }
    val key = "$last:$dir"
    val now = SystemClock.uptimeMillis()
    if (now - (askedAt[key] ?: 0L) < 3000L) return
    askedAt[key] = now
    callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($last,$dir)")
  }

  /** 已经滚到接上的最后一章的头尾还往外甩：书的两头提示，复杂章交给网页，没到的章去要 */
  private fun scrollEdge(dir: Int) {
    val last = chainEnd(dir)
    val other = (if (dir > 0) nextOf[last] else prevOf[last]) ?: -1
    when {
      other < 0 -> callJs("window.__sparkNativeEdge&&window.__sparkNativeEdge($dir)")
      webChapters.contains(other) -> callJs("window.__sparkHandoff&&window.__sparkHandoff($other,$dir)")
      else -> prepareBeyond(dir)
    }
  }

  private fun startFling(vy: Float) {
    flingY = 0
    flinger.fling(0, 0, 0, (-vy).roundToInt(), 0, 0, -FLING_SPAN, FLING_SPAN)
    postInvalidateOnAnimation()
  }

  override fun computeScroll() {
    if (!scrollMode || flinger.isFinished || !flinger.computeScrollOffset()) return
    val y = flinger.currY
    val want = (y - flingY).toFloat()
    flingY = y
    val got = scrollByPx(want)
    // 撞到接上的最后一章的头尾就停，那一章到了再接着滑
    if (abs(want) >= 1f && abs(got) < abs(want) - 0.5f) flinger.forceFinished(true)
    if (flinger.isFinished) reportPage() else postInvalidateOnAnimation()
  }

  /** 长按选字：选区只在一章里，先把当前章换成手指下面那一章 */
  private fun selectScrollAt(x: Float, y: Float) {
    var index = chapter
    var local = y + scrollY
    var guard = 0
    while (guard++ < CHAIN_MAX) {
      val book = laid[index] ?: break
      val span = spanOf(book)
      if (local >= span) {
        val other = scrollNeighbor(index, 1)
        if (other < 0) break
        local -= span
        index = other
      } else if (local < 0f) {
        val other = scrollNeighbor(index, -1)
        val prev = laid[other] ?: break
        local += spanOf(prev)
        index = other
      } else break
    }
    if (index != chapter) {
      chapter = index
      page = 0
      scrollY = local - y
    }
    selectAt(x, local)
  }

  /** 按下时正在惯性滑：这一下只是停住，不算点按 */
  private var caughtFling = false

  private fun onScrollTouch(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (visibility != VISIBLE) return false
        val onBar = selecting && barButton(event.x, event.y) >= 0
        if (!onBar && holeAt(event.x, event.y)) return false
        caughtFling = !flinger.isFinished
        flinger.forceFinished(true)
        downX = event.x
        downY = event.y
        dragging = true
        moved = false
        barDown = if (onBar) barButton(event.x, event.y) else -1
        velocity?.recycle()
        velocity = VelocityTracker.obtain().also { it.addMovement(event) }
        cancelPress()
        if (barDown >= 0) return true
        val run = Runnable {
          press = null
          if (!dragging || moved) return@Runnable
          selectScrollAt(downX, downY)
          moved = true
        }
        press = run
        main.postDelayed(run, ViewConfiguration.getLongPressTimeout().toLong())
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!dragging) return false
        velocity?.addMovement(event)
        if (barDown >= 0) return true
        // 选区还在时手指移动只是选字，不要把书页滚走，菜单会跟着跑、点不准
        if (selecting) return true
        if (!moved) {
          val dx = event.x - downX
          val dy = event.y - downY
          if (kotlin.math.hypot(dx.toDouble(), dy.toDouble()) < ViewConfiguration.get(context).scaledTouchSlop * 2) return true
          cancelPress()
          moved = true
          // 自己滚过了，之前要落的位置作废，图到了重排时不再跳回去
          pendingOffset = -1
          pendingAnchor = -1.0
          // 从过了阈值的这一点开始跟手，不然第一下会跳一截
          downY = event.y
          return true
        }
        scrollByPx(downY - event.y)
        downY = event.y
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (!dragging) return true
        dragging = false
        cancelPress()
        val config = ViewConfiguration.get(context)
        velocity?.addMovement(event)
        velocity?.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
        val vy = velocity?.yVelocity ?: 0f
        velocity?.recycle()
        velocity = null
        val up = event.actionMasked == MotionEvent.ACTION_UP
        if (barDown >= 0) {
          val hit = barButton(event.x, event.y)
          val action = if (hit == barDown) barHits[hit].first else ""
          barDown = -1
          if (action.isNotEmpty() && up) callJs("window.__sparkNativeAction&&window.__sparkNativeAction('$action')")
          return true
        }
        if (!moved) {
          if (!up || caughtFling) return true
          if (selecting) {
            clearSelection()
            callJs("window.__sparkNativeSelectClear&&window.__sparkNativeSelectClear()")
            return true
          }
          if (event.x >= width * 0.3f && event.x <= width * 0.7f) callJs("window.__sparkNativeTap&&window.__sparkNativeTap('menu')")
          return true
        }
        if (selectionGesture) {
          selectionGesture = false
          invalidate()
          return true
        }
        val edgeV = 900f * resources.displayMetrics.density
        when {
          !up -> {}
          scrollY >= maxScroll() - 1f && vy < -edgeV -> scrollEdge(1)
          scrollY <= minScroll() + 1f && vy > edgeV -> scrollEdge(-1)
          abs(vy) > config.scaledMinimumFlingVelocity -> startFling(vy)
        }
        if (flinger.isFinished) reportPage()
        invalidate()
        return true
      }
    }
    return true
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (scrollMode) return onScrollTouch(event)
    if (visibility != VISIBLE) return false
    if (event.actionMasked == MotionEvent.ACTION_DOWN && !(selecting && barButton(event.x, event.y) >= 0) && holeAt(event.x, event.y)) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (selecting) {
          val edge = handleAt(event.x, event.y)
          if (edge != 0) {
            val caret = caretAt(if (edge < 0) selA else selB, edge > 0)
            handle = edge
            pressDrag = false
            handleDx = if (caret != null) caret.left - event.x else 0f
            handleDy = if (caret != null) caret.centerY() - event.y else 0f
            dragging = true
            moved = false
            cancelPress()
            invalidate()
            return true
          }
          val hit = barButton(event.x, event.y)
          if (hit >= 0) {
            barDown = hit
            dragging = true
            moved = false
            cancelPress()
            return true
          }
        }
        barDown = -1
        selectionGesture = false
        if (flying == 0) {
          stopMotion()
          if (offset != 0f) {
            offset = 0f
            invalidate()
          }
        }
        cancelPress()
        downX = event.x
        downY = event.y
        dragging = true
        moved = false
        velocity?.recycle()
        velocity = VelocityTracker.obtain().also { it.addMovement(event) }
        val run = Runnable {
          press = null
          if (!dragging || selecting || flying != 0) return@Runnable
          selectAt(downX, downY)
          moved = true
          offset = 0f
          invalidate()
        }
        press = run
        main.postDelayed(run, ViewConfiguration.getLongPressTimeout().toLong())
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!dragging) return false
        velocity?.addMovement(event)
        // 长按选中后手指不抬接着拖，就从长按的字拉选区
        if (selecting && selectionGesture && handle == 0 && barDown < 0 && pressAt >= 0) {
          val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
          if (kotlin.math.hypot((event.x - downX).toDouble(), (event.y - downY).toDouble()) > slop) {
            handle = 1
            pressDrag = true
            handleDx = 0f
            handleDy = 0f
          }
        }
        if (handle != 0) {
          dragHandle(event.x + handleDx, event.y + handleDy)
          return true
        }
        if (barDown >= 0 || selecting) return true
        val dx = event.x - downX
        val dy = event.y - downY
        val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
        val travel = kotlin.math.hypot(dx.toDouble(), dy.toDouble()).toFloat()
        // 手指还没动够时继续等长按。动大了就是翻页，取消长按，不要把这次点按吃掉
        if (press != null && travel < slop * 2f) return true
        if (press != null) cancelPress()
        if (travel < slop * 2f) return true
        if (abs(dy) > abs(dx) * 1.2f) return true
        if (flying != 0) commitFlight()
        moved = true
        val dir = if (dx < 0f) 1 else -1
        val atEnd = (dir > 0 && page + 1 >= pageCount()) || (dir < 0 && page <= 0)
        val follow = canGo(dir) || (atEnd && linked(dir) >= 0)
        offset = if (follow) dx else dx * 0.2f
        if (anim == "none") offset = 0f
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (!dragging) return true
        dragging = false
        cancelPress()
        velocity?.addMovement(event)
        velocity?.computeCurrentVelocity(1000)
        val vx = velocity?.xVelocity ?: 0f
        velocity?.recycle()
        velocity = null
        if (handle != 0) {
          handle = 0
          pressDrag = false
          selectionGesture = false
          invalidate()
          notifySelection()
          return true
        }
        if (barDown >= 0) {
          val hit = barButton(event.x, event.y)
          val action = if (hit == barDown) barHits[hit].first else ""
          barDown = -1
          if (action.isNotEmpty() && event.actionMasked == MotionEvent.ACTION_UP) {
            callJs("window.__sparkNativeAction&&window.__sparkNativeAction('$action')")
          }
          return true
        }
        if (selecting && selectionGesture) {
          selectionGesture = false
          return true
        }
        if (selecting) {
          // clearSelection 会先把 selecting 清掉。接着 onTap 会当成没有选区，同一次点击就翻页
          clearSelection()
          callJs("window.__sparkNativeSelectClear&&window.__sparkNativeSelectClear()")
          return true
        }
        if (!moved) {
          onTap(event.x)
          return true
        }
        if (flying != 0) commitFlight()
        if (selecting) return true
        if (offset == 0f) {
          val dx = event.x - downX
          val dy = event.y - downY
          val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
          if (abs(dx) > slop * 2f && abs(dx) > abs(dy)) turnByTap(if (dx < 0f) 1 else -1)
          return true
        }
        val density = resources.displayMetrics.density
        val w = width.coerceAtLeast(1).toFloat()
        val dir = if (offset < 0f || (offset == 0f && vx < 0f)) 1 else -1
        val atEnd = (dir > 0 && page + 1 >= pageCount()) || (dir < 0 && page <= 0)
        val fling = abs(vx) > 400f * density && abs(offset) > 16f * density
        val far = abs(offset) > w * 0.28f
        val follow = canGo(dir) || (atEnd && linked(dir) >= 0)
        val commit = event.actionMasked == MotionEvent.ACTION_UP && follow && (fling || far) && anim != "none"
        val target = if (anim == "none") {
          if (event.actionMasked == MotionEvent.ACTION_UP && follow && (fling || far) && finishTurn(dir)) offset = 0f
          0f
        } else if (commit) {
          if (dir > 0) -w else w
        } else 0f
        if (target != 0f) flying = dir
        animateOffset(target) {
          if (target != 0f) {
        if (flying != dir) return@animateOffset
        flying = 0
        finishTurn(dir)
        offset = 0f
      } else offset = 0f
          invalidate()
        }
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  private fun onTap(x: Float) {
    val zone = when {
      x < width * 0.3f -> "prev"
      x > width * 0.7f -> "next"
      else -> "menu"
    }
    if (selecting) {
      clearSelection()
      callJs("window.__sparkNativeSelectClear&&window.__sparkNativeSelectClear()")
      return
    }
    if (zone == "prev" || zone == "next") {
      turnByTap(if (zone == "next") 1 else -1)
      return
    }
    callJs("window.__sparkNativeTap&&window.__sparkNativeTap('menu')")
  }

  /** 连点时正在播的那页先落定，这一下直接翻过去，不再重开一段动画 */
  private fun turnByTap(dir: Int) {
    val now = SystemClock.uptimeMillis()
    if (flying != 0) {
      if (!commitFlight()) return
      lastTurnAt = now
      if (canGo(dir)) finishTurn(dir) else requestEdge(dir)
      return
    }
    if (!canGo(dir)) {
      requestEdge(dir)
      return
    }
    val rapid = lastTurnAt != 0L && now - lastTurnAt < 280
    lastTurnAt = now
    val edge = (dir > 0 && page + 1 >= pageCount()) || (dir < 0 && page <= 0)
    val waiting = edge && neighborSlot(dir) == null && linked(dir) >= 0
    if (waiting) {
      finishTurn(dir)
      offset = 0f
      invalidate()
      return
    }
    if (anim != "none" && !rapid && neighborSlot(dir) != null) {
      flying = dir
      val w = width.coerceAtLeast(1).toFloat()
      animateOffset(if (dir > 0) -w else w) {
        if (flying != dir) return@animateOffset
        flying = 0
        finishTurn(dir)
        offset = 0f
        invalidate()
      }
      return
    }
    finishTurn(dir)
  }

  /** 落定正在播的翻页。下一章还没到时停在翻过去的位置，返回 false */
  private fun commitFlight(): Boolean {
    val dir = flying
    if (dir == 0) return false
    flying = 0
    stopMotion()
    val turned = finishTurn(dir)
    offset = 0f
    invalidate()
    return turned
  }

  private fun requestEdge(dir: Int) {
    if (linked(dir) >= 0) {
      pendingJump = dir
      callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($chapter,$dir)")
    } else callJs("window.__sparkNativeEdge&&window.__sparkNativeEdge($dir)")
  }

  private fun selectAt(x: Float, y: Float) {
    val book = laid[chapter] ?: return
    val hit = hitChar(book, x, y)
    if (hit < 0) return
    val (a, b) = sentenceAround(book.plain, hit)
    if (b <= a) return
    selecting = true
    selectionGesture = true
    pressAt = hit
    selA = a
    selB = b
    offset = 0f
    invalidate()
    notifySelection()
  }

  private fun notifySelection() {
    val book = laid[chapter] ?: return
    if (selB <= selA) return
    val sentence = book.plain.substring(selA, selB.coerceAtMost(book.plain.length)).trim()
    if (sentence.isEmpty()) return
    val nth = occurrenceBefore(book.plain, sentence, selA)
    val encoded = Base64.encodeToString(sentence.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    val density = resources.displayMetrics.density.coerceAtLeast(1f)
    val box = selectionBounds()
    val top = ((box?.top ?: height * 0.35f) / density).roundToInt()
    val bottom = ((box?.bottom ?: height * 0.5f) / density).roundToInt()
    val center = ((box?.centerX() ?: width / 2f) / density).roundToInt()
    callJs("window.__sparkNativeSelect&&window.__sparkNativeSelect($chapter,'$encoded',$nth,$top,$bottom,$center,$selA,$selB)")
  }

  /** 手指按在哪个把手上：-1 起点，1 终点。圆点和它上面那一行字都算 */
  private fun handleAt(x: Float, y: Float): Int {
    if (scrollMode) return 0
    val density = resources.displayMetrics.density
    val reach = 30f * density
    var best = 0
    var bestDist = Double.MAX_VALUE
    for (edge in intArrayOf(-1, 1)) {
      val caret = caretAt(if (edge < 0) selA else selB, edge > 0) ?: continue
      val knobY = caret.bottom + HANDLE_DP * density
      val dy = when {
        y < caret.top -> caret.top - y
        y > knobY -> y - knobY
        else -> 0f
      }
      val dist = kotlin.math.hypot((x - caret.left).toDouble(), dy.toDouble())
      if (dist <= reach && dist < bestDist) {
        best = edge
        bestDist = dist
      }
    }
    return best
  }

  /** 拖把手：手指每动一下就改选区并重画，拖过另一端时两端对调 */
  private fun dragHandle(x: Float, y: Float) {
    val book = laid[chapter] ?: return
    val at = boundaryAt(book, x, y)
    if (at < 0) return
    var a = selA
    var b = selB
    if (pressDrag) {
      if (at > pressAt) {
        a = pressAt
        b = at
      } else {
        a = at
        b = (pressAt + 1).coerceAtMost(book.plain.length)
      }
    } else if (handle < 0) {
      if (at < selB) a = at else {
        a = selB
        b = at
        handle = 1
      }
    } else {
      if (at > selA) b = at else {
        b = selA
        a = at
        handle = -1
      }
    }
    if (b <= a || (a == selA && b == selB)) return
    selA = a
    selB = b
    invalidate()
  }

  /** 这一页上离 (x, y) 最近的字间位置。拖到页边、行距里也落在最近的一行上 */
  private fun boundaryAt(book: Laid, x: Float, y: Float): Int {
    val items = book.pages.getOrNull(page) ?: return -1
    val padX = width * marginFrac
    val localY = y - padTop()
    var best: Placed? = null
    var bestDist = Float.MAX_VALUE
    for (item in items) {
      if (!item.hasText()) continue
      val dist = when {
        localY < item.top -> item.top - localY
        localY > item.top + item.height -> localY - (item.top + item.height)
        else -> 0f
      }
      if (dist < bestDist) {
        bestDist = dist
        best = item
      }
    }
    val item = best ?: return -1
    val localTop = item.lineTop(item.line0)
    val lowest = (item.lineBottom(item.line1) - 1).coerceAtLeast(localTop)
    val wanted = (localY - item.top + localTop).toInt().coerceIn(localTop, lowest)
    val line = item.lineForVertical(wanted).coerceIn(item.line0, item.line1)
    return item.origin + item.boundaryForX(line, x - padX)
  }

  private fun selectionBounds(): RectF? {
    if (selA < 0 || selB <= selA) return null
    val book = laid[chapter] ?: return null
    val items = book.pages.getOrNull(page) ?: return null
    val padX = width * marginFrac
    val padY = padTop()
    var l = Float.POSITIVE_INFINITY
    var t = Float.POSITIVE_INFINITY
    var r = Float.NEGATIVE_INFINITY
    var b = Float.NEGATIVE_INFINITY
    for (item in items) {
      val n = item.charCount()
      if (n <= 0) continue
      val start = (selA - item.origin).coerceAtLeast(0)
      val end = (selB - item.origin).coerceAtMost(n)
      if (end <= start) continue
      val lineLo = item.lineForOffset(start).coerceAtLeast(item.line0)
      val lineHi = item.lineForOffset(end - 1).coerceAtMost(item.line1)
      if (lineHi < item.line0 || lineLo > item.line1) continue
      for (line in lineLo..lineHi) {
        val from = if (line == item.lineForOffset(start)) start else item.lineStart(line)
        val to = if (line == item.lineForOffset(end - 1)) end else item.lineEnd(line)
        val left = item.xOnLine(line, from)
        val right = item.xOnLine(line, to)
        val top = padY + item.top + item.lineTop(line) - item.lineTop(item.line0)
        val bottom = padY + item.top + item.lineBottom(line) - item.lineTop(item.line0)
        l = minOf(l, padX + minOf(left, right))
        r = maxOf(r, padX + maxOf(left, right))
        t = minOf(t, top)
        b = maxOf(b, bottom)
      }
    }
    if (l == Float.POSITIVE_INFINITY) return null
    // 上下滚动时行盒是章里的坐标，要换成屏幕上的
    val shift = if (scrollMode) scrollY else 0f
    return RectF(l, t - shift, r, b - shift)
  }

  private fun hitChar(book: Laid, x: Float, y: Float): Int {
    val items = book.pages.getOrNull(page) ?: return -1
    val padX = width * marginFrac
    val padY = padTop()
    val localY = y - padY
    var best: Placed? = null
    var bestDist = Float.MAX_VALUE
    for (item in items) {
      if (!item.hasText()) continue
      val dist = when {
        localY < item.top -> item.top - localY
        localY > item.top + item.height -> localY - (item.top + item.height)
        else -> 0f
      }
      if (dist < bestDist) {
        bestDist = dist
        best = item
      }
    }
    val item = best ?: return -1
    if (bestDist > textPx) return -1
    val localTop = item.lineTop(item.line0)
    val line = item.lineForVertical((localY - item.top + localTop).toInt().coerceAtLeast(localTop)).coerceIn(item.line0, item.line1)
    val off = item.offsetForX(line, x - padX)
    return item.origin + off
  }

  /** 先选手指附近的一小段，避免没有句号时把整页都涂黄。两端可以再拖 */
  private fun sentenceAround(plain: String, hit: Int): Pair<Int, Int> {
    if (plain.isEmpty()) return 0 to 0
    val at = hit.coerceIn(0, plain.lastIndex)
    var a = at
    var b = (at + 1).coerceAtMost(plain.length)
    while (a > 0 && plain[a - 1] != '\n' && at - a < 18) a--
    while (b < plain.length && plain[b] != '\n' && b - at < 18) b++
    while (a < b && plain[a].isWhitespace()) a++
    while (b > a && plain[b - 1].isWhitespace()) b--
    if (b <= a) return at to (at + 1).coerceAtMost(plain.length)
    return a to b
  }

  private fun occurrenceBefore(plain: String, sentence: String, before: Int): Int {
    val needle = sentence.filter { !it.isWhitespace() }
    if (needle.isEmpty()) return 0
    val prefix = plain.substring(0, before.coerceIn(0, plain.length)).filter { !it.isWhitespace() }
    var n = 0
    var from = 0
    while (from <= prefix.length) {
      val at = prefix.indexOf(needle, from)
      if (at < 0) break
      n++
      from = at + needle.length
    }
    return n
  }

  private fun clearSelection() {
    if (!selecting && selA < 0) {
      flushDeferredLayout()
      return
    }
    selecting = false
    selectionGesture = false
    handle = 0
    pressDrag = false
    pressAt = -1
    selA = -1
    selB = -1
    invalidate()
    flushDeferredLayout()
  }

  private fun flushDeferredLayout() {
    if (!deferLayout) return
    deferLayout = false
    if (width > 0 && height > 0 && texts.containsKey(chapter)) relayoutCurrent()
  }

  private fun cancelPress() {
    press?.let { main.removeCallbacks(it) }
    press = null
  }

  private fun landPending(index: Int): Boolean {
    val dir = pendingJump
    if (dir == 0) return false
    val dest = if (dir > 0) nextOf[chapter] else prevOf[chapter]
    val book = laid[index]
    if (dest != index || book == null) return false
    pendingJump = 0
    askedDir = 0
    chapter = index
    val n = book.pages.size.coerceAtLeast(1)
    page = if (dir > 0) 0 else n - 1
    offset = 0f
    rasterAroundSoon()
    invalidate()
    reportPage()
    callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($index,$dir)")
    return true
  }

  /** 翻页完成返回 true。下一章还没到时停在翻过去的位置，等正文来了再接上 */
  private fun finishTurn(dir: Int): Boolean {
    pendingOffset = -1
    clearSelection()
    val count = pageCount()
    if (dir > 0 && page + 1 < count) page++
    else if (dir < 0 && page > 0) page--
    else {
      val other = linked(dir)
      if (other < 0) {
        callJs("window.__sparkNativeEdge&&window.__sparkNativeEdge($dir)")
        return true
      }
      if (webChapters.contains(other)) {
        callJs("window.__sparkHandoff&&window.__sparkHandoff($other,$dir)")
        return true
      }
      ensureLaid(other)
      val book = laid[other]
      if (book == null) {
        if (pendingJump == 0) {
          pendingJump = dir
          callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($chapter,$dir)")
        }
        return false
      }
      chapter = other
      page = if (dir > 0) 0 else book.pages.size - 1
    }
    askedDir = 0
    invalidate()
    reportPage()
    val pages = pageCount().coerceAtLeast(1)
    val edge = if (dir > 0) page >= pages - 2 else page <= 1
    if (edge) callJs("window.__sparkNeedChapter&&window.__sparkNeedChapter($chapter,$dir)")
    rasterAroundSoon()
    warmEdges()
    return true
  }

  private fun animateOffset(target: Float, then: () -> Unit) {
    stopMotion()
    val token = ++motionToken
    val from = offset
    val widthPx = width.coerceAtLeast(1)
    val remaining = abs(target - from) / widthPx
    if (remaining < 0.01f) {
      offset = target
      invalidate()
      then()
      return
    }
    val durNs = (220f * remaining).toLong().coerceIn(80L, 220L) * 1_000_000L
    var start = 0L
    val cb = object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        if (token != motionToken) return
        if (start == 0L) start = frameTimeNanos
        val t = ((frameTimeNanos - start).toFloat() / durNs).coerceIn(0f, 1f)
        val eased = 1f - (1f - t) * (1f - t)
        offset = from + (target - from) * eased
        invalidate()
        if (t < 1f) Choreographer.getInstance().postFrameCallback(this)
        else then()
      }
    }
    Choreographer.getInstance().postFrameCallback(cb)
  }

  private fun stopMotion() {
    motionToken++
  }

  private fun callJs(script: String) {
    web?.post { web?.evaluateJavascript(script, null) }
  }


  /** 当前页在这一章正文里的字符偏移。没有字的页记 0 */
  private fun pageStartOffset(): Int {
    val book = laid[chapter] ?: return 0
    if (scrollMode) return spotIn(book, scrollY).first
    val items = book.pages.getOrNull(page) ?: return 0
    for (item in items) {
      if (item.charCount() <= 0) continue
      return item.origin + item.lineStart(item.line0)
    }
    return 0
  }

  /** 章里纵坐标 y 落在哪一行：那一行首字的下标，和 y 比那一行顶低了多少 */
  private fun spotIn(book: Laid, y: Float): Pair<Int, Float> {
    var base = 0
    for (items in book.pages) {
      for (item in items) {
        if (item.charCount() <= 0) continue
        val top = base + item.top
        if (top + item.height <= y) continue
        val first = item.lineTop(item.line0)
        val local = (y - top).toInt().coerceAtLeast(0)
        val line = item.lineForVertical(first + local).coerceIn(item.line0, item.line1)
        val lineY = top + item.lineTop(line) - first
        return (item.origin + item.lineStart(line)) to (y - lineY)
      }
      base += items.maxOfOrNull { it.top + it.height } ?: 0
    }
    return 0 to y
  }

  /** 字符下标所在那一行的顶在章里的纵坐标 */
  private fun yOfOffset(book: Laid, offset: Int): Float {
    var base = 0
    var nearest = 0f
    for (items in book.pages) {
      for (item in items) {
        val n = item.charCount()
        if (n <= 0) continue
        val top = base + item.top
        if (item.origin <= offset) nearest = top.toFloat()
        val at = offset - item.origin
        if (at < 0 || at >= n) continue
        val line = item.lineForOffset(at)
        if (line !in item.line0..item.line1) continue
        return (top + item.lineTop(line) - item.lineTop(item.line0)).toFloat()
      }
      base += items.maxOfOrNull { it.top + it.height } ?: 0
    }
    return nearest
  }

  /** 字号、页宽变了要整章重排：先记下屏幕顶上那一行，排好后回到那里 */
  private fun keepScrollSpot() {
    flinger.forceFinished(true)
    if (!scrollMode) return
    val book = laid[chapter] ?: return
    scrollKeep = spotIn(book, scrollY).first to 0f
  }

  /** 同一帧里连翻几页时只报最后一页，免得网页跟着抖 */
  private fun reportPage() {
    if (pageJsPosted) return
    pageJsPosted = true
    main.post {
      pageJsPosted = false
      val start = pageStartOffset()
      val pageNo: Int
      val pageTotal: Int
      if (scrollMode) {
        val h = height.coerceAtLeast(1)
        val total = flowHeight().coerceAtLeast(1)
        pageTotal = ((total + h - 1) / h).coerceAtLeast(1)
        pageNo = (scrollY.toInt() / h).coerceIn(0, pageTotal - 1)
      } else {
        pageTotal = pageCount().coerceAtLeast(1)
        pageNo = page
      }
      callJs("window.__sparkNativePage&&window.__sparkNativePage($chapter,$pageNo,$pageTotal,$start)")
    }
  }

  /** 选字时页脚冒出来会把视口缩短。这时重排会把选区挪走，第一下就点不中划线 */
  private var deferLayout = false

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0 || (w == oldw && h == oldh) || !texts.containsKey(chapter)) return
    // 上下滚动排版不看高度，只是视口高矮变了（菜单、页脚）时不必整章重排
    if (scrollMode && w == oldw) {
      invalidate()
      return
    }
    if (selecting && w == oldw) {
      deferLayout = true
      invalidate()
      return
    }
    relayoutCurrent()
  }

  private fun relayoutCurrent() {
    keepScrollSpot()
    rasterToken++
    styleGen++
    laid.clear()
    dropShots()
    clearPool()
    layoutChapter(chapter, styleGen)
  }

  private fun payloadKey(json: String): Long {
    return (json.length.toLong() shl 32) xor (json.hashCode().toLong() and 0xffffffffL)
  }

  private fun parseBlocks(json: String): List<Block> {
    val out = ArrayList<Block>()
    val array = try {
      JSONArray(json)
    } catch (_: Exception) {
      return out
    }
    // 一章里常有几十个相同的行内图标，同一份数据只解一次
    val icons = HashMap<String, Bitmap?>()
    for (i in 0 until array.length()) {
      val obj = array.optJSONObject(i) ?: continue
      val img = obj.optString("img")
      if (img.isNotEmpty()) {
        decodeImage(img)?.let { out.add(Block(level = 0, align = ALIGN_CENTER, pre = false, runs = emptyList<Run>(), image = it)) }
        continue
      }
      val runs = ArrayList<Run>()
      val level = when (val h = obj.opt("h")) {
        is Number -> h.toInt().coerceIn(0, 6)
        true -> 2
        else -> 0
      }
      val heading = level > 0
      val align = when (obj.optString("a")) {
        "c" -> ALIGN_CENTER
        "r" -> ALIGN_RIGHT
        "l" -> ALIGN_LEFT
        else -> if (heading) ALIGN_CENTER else ALIGN_JUSTIFY
      }
      val fromRuns = obj.optJSONArray("runs")
      if (fromRuns != null) {
        for (j in 0 until fromRuns.length()) {
          val run = fromRuns.optJSONObject(j) ?: continue
          val text = run.optString("t")
          val im = run.optString("im")
          if (im.isNotEmpty()) {
            val icon = icons.getOrPut(im) { decodeImage(im) } ?: continue
            runs.add(Run("", run.optBoolean("b") || heading, run.optBoolean("i"), icon))
            continue
          }
          if (text.isEmpty()) continue
          runs.add(Run(text, run.optBoolean("b") || heading, run.optBoolean("i")))
        }
      } else {
        val text = obj.optString("t").trim()
        if (text.isNotEmpty()) runs.add(Run(text, heading, false))
      }
      if (runs.isNotEmpty()) out.add(Block(level, align, obj.optBoolean("pre"), runs, null))
    }
    return out
  }

  private fun decodeImage(data: String): Bitmap? {
    val payload = if (data.contains(",")) data.substringAfter(",") else data
    val bytes = try {
      Base64.decode(payload, Base64.DEFAULT)
    } catch (_: Exception) {
      return null
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
  }

  private fun parseMarks(json: String): List<MarkSpan> {
    val array = try {
      JSONArray(json)
    } catch (_: Exception) {
      return emptyList()
    }
    val out = ArrayList<MarkSpan>()
    for (i in 0 until array.length()) {
      val obj = array.optJSONObject(i) ?: continue
      val section = obj.optInt("s", -1)
      val start = obj.optInt("a", -1)
      val end = obj.optInt("b", -1)
      if (section >= 0 && end > start) out.add(MarkSpan(section, start, end))
    }
    return out
  }

  inner class Bridge {
    @JavascriptInterface
    fun setVisible(on: Boolean) {
      main.post { visibility = if (on) VISIBLE else GONE }
    }

    @JavascriptInterface
    fun setFrame(l: Double, t: Double, w: Double, h: Double) {
      main.post { place(l, t, w, h) }
    }

    @JavascriptInterface
    fun setStyle(bg: String, fg: String, sizePx: Double, leading: Double, margin: Double, anim: String, font: String) {
      main.post { applyStyle(bg, fg, sizePx, leading, margin, anim, font) }
    }

    /** scroll 是上下滚动，page 是左右翻页 */
    @JavascriptInterface
    fun setMode(mode: String) {
      main.post {
        val next = mode == "scroll"
        if (next == scrollMode) return@post
        // 换了翻页方式还停在同一行字上，不回到章首
        val at = if (laid[chapter] != null) pageStartOffset() else -1
        flinger.forceFinished(true)
        scrollMode = next
        scrollY = 0f
        scrollKeep = null
        pendingJump = 0
        if (at > 0) {
          landToken++
          pendingOffsetChapter = chapter
          pendingOffset = at
          pendingAnchor = -1.0
        }
        styleGen++
        laid.clear()
        dropShots()
        clearPool()
        if (width > 0 && texts.containsKey(chapter)) layoutChapter(chapter, styleGen)
        invalidate()
      }
    }

    /** web 的章节不排进原生，翻进去时交给网页 */
    @JavascriptInterface
    fun setKind(index: Int, kind: String) {
      main.post {
        if (kind == "web") webChapters.add(index) else webChapters.remove(index)
        // 章末正在等的那一章原来要交给网页：直接交过去，不要一直停在章末
        if (kind == "web" && pendingJump != 0 && linked(pendingJump) == index) {
          val dir = pendingJump
          pendingJump = 0
          callJs("window.__sparkHandoff&&window.__sparkHandoff($index,$dir)")
        }
      }
    }

    /** anchor 小于 0 表示这章先备着，不切过去。同一份正文已经排好就只翻页 */
    @JavascriptInterface
    fun setChapter(index: Int, json: String, anchor: Double) {
      main.post {
        val show = anchor >= 0
        if (show) {
          flinger.forceFinished(true)
          scrollKeep = null
          pendingJump = 0
          chapter = index
          fractionToken = landToken
          pendingAnchor = anchor
          pendingOffset = -1
          pendingOffsetChapter = -1
          clearSelection()
          offset = 0f
        }
        val key = payloadKey(json)
        val ready = laid[index]
        val willKeep = laidKeys[index] == key && ready?.gen == styleGen
        if (show && ready != null && ready.gen == styleGen) {
          placeChapter(index, ready, consumeAnchor = willKeep)
          warmEdges()
        }
        val inflight = payloadKeys[index] == key && flightGen[index] == styleGen
        if (willKeep || inflight) {
          if (show && willKeep) {
            rasterAroundSoon()
            invalidate()
            reportPage()
            warmEdges()
          }
          return@post
        }
        payloadKeys[index] = key
        val ticket = (layoutTicket[index] ?: 0) + 1
        layoutTicket[index] = ticket
        val gen = styleGen
        layoutHandler.post {
          val blocks = parseBlocks(json)
          main.post apply@{
            if (layoutTicket[index] != ticket) {
              recycleBlocks(blocks)
              return@apply
            }
            val old = texts[index]
            texts[index] = blocks
            textKeys[index] = key
            recycleBlocks(old)
            layoutChapter(index, gen, restart = true)
          }
        }
      }
    }

    /** 目录、书签要落到的字符下标。排版还没好就先记下，排完再翻到那一页 */
    @JavascriptInterface
    fun showAt(index: Int, charOffset: Int) {
      main.post {
        landToken++
        stopMotion()
        flinger.forceFinished(true)
        scrollKeep = null
        flying = 0
        clearSelection()
        pendingOffsetChapter = index
        pendingOffset = charOffset.coerceAtLeast(0)
        pendingAnchor = -1.0
        offset = 0f
        if (chapter != index) {
          chapter = index
          page = 0
        }
        val book = laid[index]
        if (book != null) {
          page = pageForOffset(book, pendingOffset)
          if (scrollMode) scrollY = yOfOffset(book, pendingOffset).coerceIn(minScroll(), maxScroll())
          rasterAroundSoon()
          reportPage()
          warmEdges()
        } else ensureLaid(index)
        invalidate()
      }
    }

    /** new：划线、写想法、复制、问 AI。anno：已有划线，末项改成删除 */
    @JavascriptInterface
    fun setSelectKind(kind: String) {
      main.post {
        selectKind = if (kind == "anno") "anno" else "new"
        invalidate()
      }
    }


    /** 菜单和选区工具条在网页里。这些区域不画书页，触摸也交回网页。单位是 CSS 像素 */
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
    fun setEnds(index: Int, next: Int, prev: Int) {
      main.post {
        if (next >= 0) nextOf[index] = next else nextOf.remove(index)
        if (prev >= 0) prevOf[index] = prev else prevOf.remove(index)
        if (scrollMode) invalidate()
        // 章末在等的章被跳过（空章）时，链接换成了已经备好的那一章，马上接上
        val dir = pendingJump
        if (dir != 0 && index == chapter) {
          val dest = linked(dir)
          when {
            dest < 0 -> {
              pendingJump = 0
              callJs("window.__sparkNativeEdge&&window.__sparkNativeEdge($dir)")
            }
            webChapters.contains(dest) -> {
              pendingJump = 0
              callJs("window.__sparkHandoff&&window.__sparkHandoff($dest,$dir)")
            }
            laid[dest] != null -> landPending(dest)
            else -> ensureLaid(dest)
          }
        }
      }
    }

    @JavascriptInterface
    fun setMarks(json: String) {
      main.post {
        marks = parseMarks(json)
        quoteStamp++
        // 上下滚动的高亮是现画的，不进位图。不刷新的话要等下一次滚动才消失
        invalidate()
        rasterAroundSoon(forceAll = true)
      }
    }

    @JavascriptInterface
    fun clearSelect() {
      main.post { clearSelection() }
    }

    /**
     * 选字菜单点在原生页上，网页没有用户手势，Clipboard API 会拒绝。
     * 在主线程写入并返回是否成功。不记录文字内容。
     */
    @JavascriptInterface
    fun copyText(text: String): Boolean {
      if (Looper.myLooper() == Looper.getMainLooper()) return writeClipboard(text)
      val ok = java.util.concurrent.atomic.AtomicBoolean(false)
      val latch = CountDownLatch(1)
      main.post {
        try {
          ok.set(writeClipboard(text))
        } finally {
          latch.countDown()
        }
      }
      return try {
        latch.await(2, TimeUnit.SECONDS) && ok.get()
      } catch (_: InterruptedException) {
        false
      }
    }

    @JavascriptInterface
    fun clear() {
      main.post {
        rasterToken++
        stopMotion()
        flinger.forceFinished(true)
        scrollY = 0f
        scrollKeep = null
        askedAt.clear()
        flying = 0
        cancelPress()
        for (list in texts.values) recycleBlocks(list)
        texts.clear()
        laid.clear()
        payloadKeys.clear()
        laidKeys.clear()
        textKeys.clear()
        markCache.clear()
        quoteStamp++
        nextOf.clear()
        prevOf.clear()
        webChapters.clear()
        pendingJump = 0
        marks = emptyList()
        clearSelection()
        offset = 0f
        holes = emptyList()
        dropShots()
        clearPool()
        visibility = GONE
      }
    }
  }

  /**
   * 安卓 13 起系统会自己弹「已复制」。标成敏感后不再弹，避免和书页上的提示叠成两条。
   * 文字仍在剪贴板里，可以粘贴。
   */
  private fun writeClipboard(text: String): Boolean {
    return try {
      val manager = context.getSystemService(ClipboardManager::class.java) ?: return false
      val clip = ClipData.newPlainText("text", text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val extras = PersistableBundle()
        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        clip.description.setExtras(extras)
      }
      manager.setPrimaryClip(clip)
      true
    } catch (_: Exception) {
      false
    }
  }

  /** icon 是夹在字里的小图，这时 text 为空，不占字符 */
  private class Run(val text: String, val bold: Boolean, val italic: Boolean, val icon: Bitmap? = null)
  /** level 是标题级别（0 是正文）；align 见 ALIGN_* */
  private class Block(val level: Int, val align: Int, val pre: Boolean, val runs: List<Run>, val image: Bitmap?) {
    val heading: Boolean get() = level > 0
  }
  /** width 是排版用的宽度；full 是字形本来的宽度。标点被挤压时 width 比 full 小 */
  private class RawGlyph(
    val index: Int,
    val text: String,
    var width: Float,
    val full: Float,
    val bold: Boolean,
    val italic: Boolean,
    val icon: Bitmap? = null,
  )
  /** shift 是画字时的横向偏移：开口标点挤压后字形要往左挪，才不会压到后一个字 */
  private class Glyph(
    val index: Int,
    val text: String,
    val x: Float,
    val width: Float,
    val bold: Boolean,
    val italic: Boolean,
    val shift: Float = 0f,
    val icon: Bitmap? = null,
  )
  private class BodyLine(
    val start: Int,
    val end: Int,
    val top: Int,
    val bottom: Int,
    val glyphs: List<Glyph>,
  )
  private class BodyText(
    val text: String,
    val lines: List<BodyLine>,
    val baseline: Float,
    val regular: TextPaint,
    val bold: TextPaint,
    val italic: TextPaint,
    val boldItalic: TextPaint,
  )
  /** 图的 left、imageWidth 是在正文宽度里居中后的位置和宽度 */
  private class Placed(
    val layout: StaticLayout?,
    val body: BodyText?,
    val line0: Int,
    val line1: Int,
    val image: Bitmap?,
    val height: Int,
    val top: Int,
    val origin: Int,
    val left: Int = 0,
    val imageWidth: Int = 0,
  ) {
    fun hasText(): Boolean = layout != null || body != null

    fun charCount(): Int = layout?.text?.length ?: body?.text?.length ?: 0

    fun lineForOffset(offset: Int): Int {
      val layout = layout
      if (layout != null) {
        val n = layout.text.length
        if (n <= 0) return 0
        return layout.getLineForOffset(offset.coerceIn(0, n))
      }
      val lines = body?.lines
      if (lines.isNullOrEmpty()) return 0
      val at = offset.coerceIn(0, lines.last().end.coerceAtLeast(0))
      for (i in lines.indices) {
        if (at < lines[i].end || i == lines.lastIndex) return i
      }
      return 0
    }

    fun lineStart(line: Int): Int {
      layout?.let { return it.getLineStart(line) }
      return body?.lines?.getOrNull(line)?.start ?: 0
    }

    fun lineEnd(line: Int): Int {
      layout?.let { return it.getLineEnd(line) }
      return body?.lines?.getOrNull(line)?.end ?: 0
    }

    fun lineTop(line: Int): Int {
      layout?.let { return it.getLineTop(line) }
      return body?.lines?.getOrNull(line)?.top ?: 0
    }

    fun lineBottom(line: Int): Int {
      layout?.let { return it.getLineBottom(line) }
      return body?.lines?.getOrNull(line)?.bottom ?: 0
    }

    fun lineForVertical(y: Int): Int {
      val layout = layout
      if (layout != null) return layout.getLineForVertical(y)
      val lines = body?.lines ?: return 0
      if (lines.isEmpty()) return 0
      for (i in lines.indices) {
        if (y < lines[i].bottom) return i
      }
      return lines.lastIndex
    }

    fun xOnLine(line: Int, offset: Int): Float {
      val layout = layout
      if (layout != null) {
        val a = layout.getLineStart(line)
        val b = layout.getLineEnd(line)
        return layout.getPrimaryHorizontal(offset.coerceIn(a, b))
      }
      val ln = body?.lines?.getOrNull(line) ?: return 0f
      if (ln.glyphs.isEmpty()) return 0f
      if (offset >= ln.end) {
        val last = ln.glyphs.last()
        return last.x + last.width
      }
      for (g in ln.glyphs) {
        if (offset <= g.index) return g.x
      }
      val last = ln.glyphs.last()
      return last.x + last.width
    }

    fun offsetForX(line: Int, x: Float): Int {
      val layout = layout
      if (layout != null) return layout.getOffsetForHorizontal(line, x)
      val ln = body?.lines?.getOrNull(line) ?: return 0
      if (ln.glyphs.isEmpty()) return ln.start
      for (g in ln.glyphs) {
        if (x < g.x + g.width / 2f) return g.index
      }
      return ln.end
    }

    /** 选区端点落在两个字之间。行末的硬换行不算进选区 */
    fun boundaryForX(line: Int, x: Float): Int {
      val at = offsetForX(line, x)
      val end = lineEnd(line)
      val text = layout?.text ?: body?.text ?: return at
      return if (at >= end && end > lineStart(line) && end <= text.length && text[end - 1] == '\n') end - 1 else at
    }

    /** offset 这个字的右边 */
    fun rightOf(line: Int, offset: Int): Float {
      val layout = layout
      if (layout != null) {
        val end = layout.getLineEnd(line)
        val next = offset + 1
        if (next < end && layout.text[next - 1] != '\n') return layout.getPrimaryHorizontal(next)
        return layout.getLineRight(line)
      }
      val ln = body?.lines?.getOrNull(line) ?: return 0f
      val g = ln.glyphs.lastOrNull { it.index <= offset } ?: return xOnLine(line, offset)
      return g.x + g.width
    }
  }
  private class MarkSpan(val section: Int, val start: Int, val end: Int)
  private class Laid(val pages: List<List<Placed>>, val plain: String, val width: Int, val height: Int, val gen: Int) {
    /** 所有页竖着接起来的高度，上下滚动用 */
    val flow: Int by lazy { pages.sumOf { items -> items.maxOfOrNull { it.top + it.height } ?: 0 } }
  }
  private class PageDraw(val key: Key, val book: Laid, val page: Int)
  private data class Key(val chapter: Int, val page: Int, val gen: Int, val width: Int, val height: Int)

  private fun parseHoles(json: String): List<RectF> {
    val array = try {
      JSONArray(json)
    } catch (_: Exception) {
      return emptyList()
    }
    val density = resources.displayMetrics.density
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

  companion object {
    /** 正文离页面上下边的距离（dp）。页面顶上紧挨状态栏，留多一点 */
    private const val PAD_TOP_DP = 22f
    private const val PAD_BOTTOM_DP = 8f
    /** 选区把手圆点的半径（dp） */
    private const val HANDLE_DP = 9f
    /** 上下滚动时最多往一侧接几章（短章连着时也盖得满一屏） */
    private const val CHAIN_MAX = 8
    /** 惯性滑动不设边界，到头由 scrollByPx 停住 */
    private const val FLING_SPAN = 50_000_000
    /** 竖排形式标点和对应的横排标点，按位置一一对应 */
    private const val VERTICAL_FORMS = "\uFE10\uFE11\uFE12\uFE13\uFE14\uFE15\uFE16\uFE17\uFE18\uFE19\uFE30\uFE31\uFE32\uFE33\uFE34\uFE35\uFE36\uFE37\uFE38\uFE39\uFE3A\uFE3B\uFE3C\uFE3D\uFE3E\uFE3F\uFE40\uFE41\uFE42\uFE43\uFE44\uFE47\uFE48"
    private const val HORIZONTAL_FORMS = "，、。：；！？〖〗…‥—–__（）｛｝〔〕【】《》〈〉「」『』［］"
    private const val ALIGN_JUSTIFY = 0
    private const val ALIGN_CENTER = 1
    private const val ALIGN_RIGHT = 2
    private const val ALIGN_LEFT = 3
    private const val OPENING = "「『（《〈【〖〔［｛〘〚“‘([{"
    private const val CLOSING = "」』）》〉】〗〕］｝〙〛”’，。、；：！？…‥·,.!?;:)]}"
    private const val SQUEEZE = "，。、；：！？「」『』（）《》〈〉【】“”’,.;:!?()"

    private fun parseColor(hex: String, fallback: Int): Int = try {
      Color.parseColor(hex)
    } catch (_: Exception) {
      fallback
    }
  }
}
