const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    #expandMisses = 0
    #expandQueued = false
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                const background = getBackground(doc)
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        const root = doc.documentElement
        // 分栏时写在元素上的固定宽高不带 !important，不清掉会把上下滚动锁成一页高
        root.style.height = ''
        root.style.width = ''
        setStylesImportant(root, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'column-count': '1',
            'column-fill': 'balance',
            'height': 'auto',
            'width': 'auto',
            'min-height': '0',
            'min-width': '0',
            'overflow': 'visible',
            'max-height': 'none',
            'max-width': 'none',
        })
        setStylesImportant(doc.body, {
            'max-width': vertical ? 'none' : `${columnWidth}px`,
            'max-height': vertical ? `${columnWidth}px` : 'none',
            'margin': 'auto',
            'height': 'auto',
            'min-height': '0',
            'overflow': 'visible',
        })
        this.#element.style.flexDirection = 'column'
        this.#element.style.justifyContent = 'flex-start'
        this.#element.style.alignItems = 'stretch'
        this.#element.style.boxSizing = 'border-box'
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        this.#element.style.justifyContent = 'center'
        this.#element.style.boxSizing = 'content-box'
        this.#element.style.maxWidth = 'none'
        this.#element.style.maxHeight = 'none'
        this.#element.style.minWidth = ''
        this.#element.style.minHeight = ''
        this.#iframe.style.maxWidth = 'none'
        this.#iframe.style.maxHeight = 'none'
        this.#iframe.style.minWidth = ''
        this.#iframe.style.minHeight = ''

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
            // 书自己的左右内边距会叠在页边距上，而且常常右边更大
            'padding': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    /** 只认已经写成像素的高度。100% 会被 parseFloat 看成 100，短章就锁成一整屏 */
    #px(value) {
        const raw = String(value || '')
        if (!raw.endsWith('px')) return 0
        const n = parseFloat(raw)
        return n > 1 ? n : 0
    }
    /**
     * 正文有多高。先把 iframe 收到 0，再量。
     * 不收的话，WebView 里 body 会被拉成上一轮的 iframe 高，章末就空出一大截。
     */
    #measureScrolled(side) {
        const doc = this.document
        const body = doc?.body
        const root = doc?.documentElement
        if (!body || !root) return 0
        root.style.setProperty(side, 'auto', 'important')
        root.style.setProperty('min-' + side, '0', 'important')
        body.style.setProperty(side, 'auto', 'important')
        body.style.setProperty('min-' + side, '0', 'important')
        body.style.setProperty('overflow', 'visible', 'important')
        this.#iframe.style[side] = '0px'
        this.#element.style[side] = 'auto'
        void body.offsetHeight
        let end = 0
        for (const child of body.children) {
            const tail = side === 'height'
                ? child.offsetTop + child.offsetHeight
                : child.offsetLeft + child.offsetWidth
            if (tail > end) end = tail
        }
        const scroll = side === 'height' ? body.scrollHeight : body.scrollWidth
        const range = doc.createRange()
        range.selectNodeContents(body)
        const rect = range.getBoundingClientRect()
        const boxed = side === 'height' ? rect.height : rect.width
        let size = Math.max(end, boxed)
        // 滚动高度只在和内容差不多时才采信，避免把被撑高的空白算进去
        if (scroll > 1 && (size <= 1 || scroll <= size * 1.2)) size = Math.max(size, scroll)
        if (!(size > 1)) return 0
        return Math.ceil(size)
    }
    #scheduleScrolledExpand() {
        if (this.#element.style.visibility === 'hidden') return
        if (this.#expandQueued) return
        this.#expandMisses++
        if (this.#expandMisses > 30) return
        this.#expandQueued = true
        requestAnimationFrame(() => {
            this.#expandQueued = false
            if (this.#column || !this.document?.body) return
            this.expand()
        })
    }
    /** 藏着排版的 iframe 显示后，WebView 里文字层有时是空的。不要用 display:none，那会把已经排好的字清掉 */
    wake() {
        if (!this.document?.body) return
        this.#expandMisses = 0
        this.expand()
        this.kickPaint()
    }
    kickPaint() {
        const body = this.document?.body
        if (!body) return
        body.style.setProperty('transform', 'translateZ(0)')
        requestAnimationFrame(() => body.style.removeProperty('transform'))
    }
    expand() {
        if (!this.document?.documentElement) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const parent = this.#element.parentElement
            const cross = otherSide === 'width' ? parent?.clientWidth ?? 0 : parent?.clientHeight ?? 0
            this.#element.style.boxSizing = 'border-box'
            this.#element.style.justifyContent = 'flex-start'
            this.#element.style.maxWidth = otherSide === 'width' ? '100%' : 'none'
            this.#element.style.maxHeight = otherSide === 'height' ? '100%' : 'none'
            this.#iframe.style.maxWidth = otherSide === 'width' ? '100%' : 'none'
            this.#iframe.style.maxHeight = otherSide === 'height' ? '100%' : 'none'
            // 不要把每一章撑满一屏，否则章和章之间会空出一块，滚过去像刷新
            this.#element.style.minWidth = ''
            this.#element.style.minHeight = ''
            this.#iframe.style.minWidth = ''
            this.#iframe.style.minHeight = ''
            const padding = '0'
            this.#element.style.padding = padding
            // 左右翻页时 iframe 跟整章一样宽。先收成容器宽度再量高度，
            // 否则量到的是 0 或一页，切到上下滚动后整屏空白
            if (cross > 1) {
                const px = `${Math.round(cross)}px`
                this.#iframe.style[otherSide] = px
                this.#element.style[otherSide] = px
            } else {
                this.#iframe.style[otherSide] = '100%'
                this.#element.style[otherSide] = '100%'
            }
            const scroller = this.#element.parentElement
            const savedScroll = scroller?.scrollTop ?? 0
            if (scroller) scroller.dataset.sparkMeasure = '1'
            const contentSize = this.#measureScrolled(side)
            if (!(contentSize > 1)) {
                if (!(this.#px(this.#iframe.style[side]) > 1)) {
                    this.#iframe.style[side] = 'auto'
                    this.#element.style[side] = 'auto'
                }
                if (scroller) {
                    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
                    const next = Math.min(savedScroll, max)
                    if (Math.abs(scroller.scrollTop - next) > 1) scroller.scrollTop = next
                    delete scroller.dataset.sparkMeasure
                }
                this.#scheduleScrolledExpand()
                return
            }
            this.#expandMisses = 0
            const expandedSize = contentSize
            const current = this.#px(this.#iframe.style[side])
            if (!(current > 1) || Math.abs(current - expandedSize) > 2) {
                this.#iframe.style[side] = `${expandedSize}px`
                this.#element.style[side] = `${expandedSize}px`
            }
            if (scroller) {
                const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
                const next = Math.min(savedScroll, max)
                if (Math.abs(scroller.scrollTop - next) > 1) scroller.scrollTop = next
                delete scroller.dataset.sparkMeasure
            }
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
            /* hidden views are placed in its scrolled content and clipped by it */
            position: relative;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
            /* 接上一章时自己补滚动。浏览器再锚定一次，视口会跳，章节名就来回闪 */
            overflow-anchor: none;
            scrollbar-gutter: stable;
            /* 留白只放在整条滚动的两头。每章各自留，章和章之间会空出一块 */
            padding-top: var(--_margin);
            padding-bottom: var(--_margin);
            box-sizing: border-box;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', () => this.#onUserScroll(), { passive: true })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        // Spark: no drag-to-turn here; the app turns pages itself. Its `snap`
        // also loads the adjacent section without taking the navigation lock:
        // a tap on the blank page shown while the next section loads replaced
        // that load, and the lock was never released again.

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                // Spark: 手指还按着选字时不翻页。分栏里换行会把选区伸进下一页，
                // 原来这里会调用 next()/prev()，选字换行就被当成翻页。
                if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
            this.#watchSectionEdge(doc)
        })

        this.#mediaQueryListener = () => {
            if (!this.#view?.document) return
            this.#paintBackground(getBackground(this.#view.document))
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    // Spark: a view is created next to the current one and only replaces it
    // once its section is loaded, laid out and its fonts are ready. Replacing
    // the view up front left a blank page (and a reflow when fonts arrived)
    // between two sections, which showed up as a flicker.
    #pendingView
    #hiddenView() {
        const view = new View({
            container: this,
            // a view that is not on screen yet must not move the current one
            onExpand: () => {
                if (this.scrolled) this.#holdScrolledScroll(view)
                else if (view === this.#view) this.#scrollToAnchor(this.#anchor)
            },
        })
        // keep it out of the visible flex flow so the current page does not
        // resize or scroll while the next section is loading
        const el = view.element
        el.style.position = 'absolute'
        el.style.left = '0'
        el.style.pointerEvents = 'none'
        if (this.scrolled) {
            // visibility:hidden 里载入的 iframe，WebView 滚到跟前时文字层仍是空的
            el.style.top = '-10000px'
            el.style.width = '100%'
            el.style.visibility = 'visible'
        } else {
            el.style.top = '0'
            el.style.visibility = 'hidden'
        }
        this.#container.append(el)
        return view
    }
    #createView() {
        this.#discardPendingView()
        const view = this.#hiddenView()
        this.#pendingView = view
        return view
    }
    #prepareDoc(doc) {
        // language and direction change the layout, so they are set before the
        // first layout, also for sections that are only preloaded
        this.dispatchEvent(new CustomEvent('prepare', { detail: { doc } }))
        const root = doc.documentElement
        if (!root) return
        if (!doc.head) root.prepend(doc.createElement('head'))
        if (!this.#styleMap.has(doc)) {
            const $styleBefore = doc.createElement('style')
            doc.head.prepend($styleBefore)
            const $style = doc.createElement('style')
            doc.head.append($style)
            this.#styleMap.set(doc, [$styleBefore, $style])
        }
        this.#applyStyles(doc)
    }
    // Spark: the sections before and after the current one are loaded and laid
    // out ahead of time in hidden views. Turning into one of them then swaps
    // views at once instead of waiting for the load, and `peek` can show its
    // first or last page so the app can capture it before the turn.
    /** 上下滚动时叠在同一条滚动里的章节，滚过界不用整页换掉 */
    #spine = new Map()
    #paintObs
    #views = new WeakMap()
    #extending = new Set()
    #spares = new Map()
    preload(dir) {
        if (this.scrolled || !this.#view) return Promise.resolve(false)
        const neighbours = [this.#adjacentIndex(-1), this.#adjacentIndex(1)]
        for (const i of [...this.#spares.keys()])
            if (!neighbours.includes(i)) this.#dropSpare(i)
        const index = this.#adjacentIndex(dir)
        if (index == null) return Promise.resolve(false)
        const existing = this.#spares.get(index)
        if (existing) return existing.ready
        const view = this.#hiddenView()
        const spare = { view, loaded: false, done: false }
        this.#spares.set(index, spare)
        spare.ready = (async () => {
            try {
                const src = await this.sections[index].load()
                if (this.#spares.get(index) !== spare) {
                    this.sections[index].unload?.()
                    return false
                }
                spare.loaded = true
                await view.load(src, doc => this.#prepareDoc(doc), this.#beforeRender.bind(this))
                await Promise.race([view.document?.fonts?.ready, wait(1500)])
                spare.done = this.#spares.get(index) === spare
                return spare.done
            } catch (e) {
                console.warn(e)
                return false
            }
        })()
        return spare.ready
    }
    #dropSpare(index) {
        const spare = this.#spares.get(index)
        if (!spare) return
        this.#spares.delete(index)
        if (this.#peeked?.spare === spare) this.unpeek()
        spare.view.destroy()
        spare.view.element.remove()
        if (spare.loaded) this.sections[index].unload?.()
    }
    #dropSpares() {
        for (const i of [...this.#spares.keys()]) this.#dropSpare(i)
    }
    // returns the laid out view of a preloaded section and forgets it
    #takeSpare(index) {
        const spare = this.#spares.get(index)
        if (!spare?.done) return null
        this.#spares.delete(index)
        // the navigation loaded the section once more; the preload's reference
        // is not needed any longer
        this.sections[index].unload?.()
        return spare.view
    }
    #peeked = null
    #relayoutPending = false
    /** 上下滚动时上次的容器滚动位置，用来判断手指是往章末还是往章首 */
    #scrollTick = 0
    /** 程序自己滚的时候不要当成用户滑到了章末 */
    #suppressContinue = false
    #muteToken = 0
    // Spark: shows the page `distance` steps before (-1) or after (1) the current
    // one without navigating, so the app can capture it; `unpeek` brings the
    // current page back. Returns false when that page is not at hand (book edge,
    // the next section is not preloaded yet, vertical or right-to-left books).
    peek(dir, distance = 1) {
        this.unpeek()
        if (this.scrolled || this.#vertical || this.#rtl || !this.#view) return false
        const dist = Math.max(1, Math.trunc(distance) || 1)
        const { page, pages, size } = this
        const target = page + dir * dist
        const element = this.#container
        if (target >= 1 && target <= pages - 2) {
            this.#peeked = { scroll: element.scrollLeft }
            element.scrollLeft = target * size
            return true
        }
        const index = this.#adjacentIndex(dir)
        const spare = index == null ? null : this.#spares.get(index)
        if (!spare?.done) return false
        const el = spare.view.element
        const sparePages = Math.round(el.getBoundingClientRect().width / size)
        if (sparePages < 3) return false
        // 本章内容页是 1..pages-2。超出的页数落到旁边那一章里
        const overflow = dir > 0 ? target - (pages - 2) : 1 - target
        const sparePage = dir > 0 ? overflow : sparePages - 1 - overflow
        if (sparePage < 1 || sparePage > sparePages - 2) return false
        el.style.left = `${element.scrollLeft - sparePage * size}px`
        el.style.visibility = 'visible'
        this.#view.element.style.visibility = 'hidden'
        this.#peeked = { spare }
        return true
    }
    unpeek() {
        const peeked = this.#peeked
        if (!peeked) return
        this.#peeked = null
        if (peeked.spare) {
            const el = peeked.spare.view.element
            el.style.visibility = 'hidden'
            el.style.left = '0'
            if (this.#view) this.#view.element.style.visibility = ''
        } else this.#container.scrollLeft = peeked.scroll
    }
    #discardPendingView() {
        const view = this.#pendingView
        if (!view) return
        this.#pendingView = null
        view.destroy()
        view.element.remove()
    }
    // returns false if `view` was dropped in favour of a later navigation
    #swapView(view) {
        if (view !== this.#pendingView) return false
        this.#pendingView = null
        const el = view.element
        el.style.position = ''
        el.style.left = ''
        el.style.top = ''
        el.style.visibility = ''
        el.style.pointerEvents = ''
        const old = this.#view
        this.#forgetSpine()
        if (old) {
            old.destroy()
            this.#container.removeChild(old.element)
        }
        this.#view = view
        // 藏着加载的那一帧量出来常常是 0，显示后再量一次，否则整章没有字
        if (this.scrolled) view.wake()
        return true
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // 书页四周的留白用正文底色。没拿到颜色时不要赋空值，否则会把原来的底色清掉，露出 WebView 的白
        this.#paintBackground(background)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    #paintBackground(value) {
        if (typeof value !== 'string') return
        const color = value.trim()
        if (!color || color === 'transparent' || color.startsWith('rgba(0, 0, 0, 0)')) return
        this.#background.style.background = color
        this.#container.style.background = color
    }
    /** 翻页用的那根滚动轴换成另一根之后，把剩下的那根归零，不然会停在左右分页的空白页上 */
    #resetCrossScroll() {
        const element = this.#container
        if (!element) return
        if (this.scrollProp === 'scrollTop') element.scrollLeft = 0
        else element.scrollTop = 0
    }
    render() {
        if (!this.#view) return
        const anchor = this.#anchor
        // preloaded sections were laid out for the old size or flow
        this.unpeek()
        this.#dropSpares()
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#resetCrossScroll()
        void this.#scrollToAnchor(anchor)
        if (!this.scrolled) this.#forgetSpine()
        else this.#adoptScrolled()
        // 分栏拆掉的第一帧高度经常还是旧的，下一帧再量一次，避免锁成空白
        if (this.scrolled && !this.#relayoutPending) {
            this.#relayoutPending = true
            requestAnimationFrame(() => {
                this.#relayoutPending = false
                if (!this.scrolled || !this.#view) return
                this.#anchor = anchor
                this.#view.expand()
                this.#resetCrossScroll()
                void this.#scrollToAnchor(anchor)
            })
        }
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        const scroll = Math.abs(this.#container[this.scrollProp])
        if (!this.scrolled || !this.#view) return scroll
        return scroll - this.#viewOrigin()
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#flowOffset(this.#getRectMapper()(rect).left - this.#margin)
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    #setScroll(element, prop, value) {
        this.#muteScroll(() => { element[prop] = value })
    }
    #absScroll() {
        return Math.abs(this.#container?.[this.scrollProp] || 0)
    }
    /** 上下滚动的偏移是相对当前章的；上面还有章时要加上那一章的起点 */
    #flowOffset(offset) {
        if (!this.scrolled || this.#vertical || !this.#view) return offset
        return offset + this.#viewOrigin()
    }
    /** 程序改滚动位置时，不要当成手指滑到了章界。下一帧再放开，同步的 scroll 事件也能盖住 */
    #muteScroll(fn) {
        this.#suppressContinue = true
        try {
            fn()
        } finally {
            this.#scrollTick = this.#absScroll()
            const token = ++this.#muteToken
            requestAnimationFrame(() => {
                if (token !== this.#muteToken) return
                this.#scrollTick = this.#absScroll()
                this.#suppressContinue = false
            })
        }
    }
    #viewOrigin() {
        if (!this.#view) return 0
        const el = this.#view.element
        return this.scrollProp === 'scrollTop' ? el.offsetTop : el.offsetLeft
    }
    /** 上面那一章变高时补上滚动位置，正在看的字不会被顶走 */
    #holdScrolledScroll(view) {
        const el = view.element
        // 还在屏幕外加载的章不占滚动高度，补了会把正在看的字拽走
        if (!el?.isConnected || el.style.position === 'absolute') return
        let listed = false
        for (const v of this.#spine.values()) if (v === view) { listed = true; break }
        if (!listed) return
        const next = el.getBoundingClientRect()[this.sideProp]
        const prev = Number(el.dataset.spineH || 0)
        el.dataset.spineH = String(next)
        if (!(prev > 0) || Math.abs(next - prev) < 1) return
        const origin = this.scrollProp === 'scrollTop' ? el.offsetTop : el.offsetLeft
        const scroll = this.#absScroll()
        if (origin + prev > scroll + 1) return
        this.#muteScroll(() => { this.#container[this.scrollProp] += next - prev })
    }
    #forgetSpine() {
        for (const [index, view] of this.#spine) {
            if (view === this.#view) continue
            view.destroy()
            view.element.remove()
            this.sections[index]?.unload?.()
        }
        this.#spine.clear()
        this.#extending.clear()
    }
    #adoptScrolled() {
        if (!this.scrolled || !this.#view) return
        const el = this.#view.element
        el.style.position = 'relative'
        el.style.left = ''
        el.style.top = ''
        el.style.visibility = ''
        el.style.pointerEvents = ''
        el.dataset.spineH = String(el.getBoundingClientRect()[this.sideProp])
        this.#spine.set(this.#index, this.#view)
        this.#armScrolled(this.#view)
        void this.#extendScrolled(1)
        void this.#extendScrolled(-1)
    }
    /** 章滚进屏幕再量一次并补画。屏幕外量高会偏大，文字层也会是空的 */
    #armScrolled(view) {
        if (!view?.element || !this.scrolled) return
        if (!this.#paintObs) {
            this.#paintObs = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.intersectionRatio <= 0) continue
                    this.#paintObs.unobserve(entry.target)
                    const v = this.#views.get(entry.target)
                    if (!v?.document || !this.scrolled) continue
                    this.#prepareDoc(v.document)
                    v.render(this.#beforeRender({
                        vertical: this.#vertical,
                        rtl: this.#rtl,
                    }))
                    v.kickPaint()
                }
            }, { root: this.#container, rootMargin: '80px' })
        }
        this.#views.set(view.element, view)
        this.#paintObs.observe(view.element)
    }
    #sectionBox(view) {
        const el = view.element
        const top = this.scrollProp === 'scrollTop' ? el.offsetTop : el.offsetLeft
        const extent = this.scrollProp === 'scrollTop' ? el.offsetHeight : el.offsetWidth
        return { top, bottom: top + extent }
    }
    #placeScrolled(index, el) {
        const next = [...this.#spine.entries()].filter(([i]) => i > index).sort((a, b) => a[0] - b[0])[0]
        if (next) this.#container.insertBefore(el, next[1].element)
        else this.#container.append(el)
    }
    /** 邻章还在当前章旁边就接上。滚到邻章时不要把正在加载的那一章丢掉 */
    #extendStillWanted(index) {
        return this.scrolled && !!this.#view && !this.#spine.has(index) && this.#index !== index && Math.abs(index - this.#index) <= 1
    }
    /** 插入或拆掉一章后，把视口补回原来的字。浏览器若已经锚定过，就不再补一次 */
    #keepPlace(beforeTop, beforeScroll) {
        if (!this.#view?.element?.isConnected) return
        const prop = this.scrollProp
        const need = (this.#sectionBox(this.#view).top - beforeTop) - (this.#container[prop] - beforeScroll)
        if (Math.abs(need) > 1) this.#container[prop] += need
    }
    /** 把旁边那一章接到当前章的上面或下面，滚动位置不动 */
    async #extendScrolled(dir) {
        if (!this.scrolled || !this.#view) return
        const index = this.#adjacentIndex(dir)
        if (index == null || this.#spine.has(index) || this.#extending.has(index)) return
        this.#extending.add(index)
        let loaded = false
        const view = this.#hiddenView()
        const el = view.element
        // 先放到最终顺序再加载。加载完再挪 iframe，文档会重开，阅读设置和点按都会丢
        this.#placeScrolled(index, el)
        try {
            const src = await this.sections[index].load()
            loaded = true
            if (!this.#extendStillWanted(index)) {
                this.sections[index].unload?.()
                loaded = false
                view.destroy()
                view.element.remove()
                return
            }
            await view.load(src, doc => this.#prepareDoc(doc), this.#beforeRender.bind(this))
            await Promise.race([view.document?.fonts?.ready, wait(800)])
            if (!this.#extendStillWanted(index)) {
                view.destroy()
                view.element.remove()
                this.sections[index].unload?.()
                loaded = false
                return
            }
            const beforeTop = this.#sectionBox(this.#view).top
            const beforeScroll = this.#container[this.scrollProp]
            this.#muteScroll(() => {
                el.style.position = 'relative'
                el.style.left = ''
                el.style.top = ''
                el.style.visibility = 'visible'
                el.style.pointerEvents = 'auto'
                el.style.width = '100%'
                this.#prepareDoc(view.document)
                view.render(this.#beforeRender({
                    vertical: this.#vertical,
                    rtl: this.#rtl,
                }))
                view.kickPaint()
                this.#keepPlace(beforeTop, beforeScroll)
                el.dataset.spineH = String(el.getBoundingClientRect()[this.sideProp])
            })
            this.#spine.set(index, view)
            this.#armScrolled(view)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.dispatchEvent(new CustomEvent('load', { detail: { doc: view.document, index } }))
            requestAnimationFrame(() => {
                if (this.#spine.get(index) !== view || !this.scrolled) return
                view.expand()
            })
        } catch (e) {
            console.warn(e)
            view.destroy()
            view.element.remove()
            if (loaded) this.sections[index].unload?.()
        } finally {
            this.#extending.delete(index)
        }
    }
    #trimScrolled() {
        const keep = new Set([this.#index - 1, this.#index, this.#index + 1])
        for (const [index, view] of [...this.#spine]) {
            if (keep.has(index) || view === this.#view) continue
            const beforeTop = this.#view?.element?.isConnected ? this.#sectionBox(this.#view).top : 0
            const beforeScroll = this.#container[this.scrollProp]
            this.#spine.delete(index)
            view.destroy()
            view.element.remove()
            this.sections[index]?.unload?.()
            this.#muteScroll(() => this.#keepPlace(beforeTop, beforeScroll))
        }
    }
    /** 视线跨过章界时只改当前章，不把画面拉回章首 */
    #followScrolled() {
        if (!this.scrolled || this.#spine.size < 2 || !this.#view) return
        const scroll = this.#absScroll()
        const max = Math.max(0, this.#container.scrollHeight - this.size)
        // 短的最后一章贴不到屏幕顶。已经滚到底时，用屏幕下沿判断，章节名才会换成它
        const anchor = scroll >= max - 2
            ? scroll + Math.max(0, this.size - 8)
            : scroll + Math.min(48, Math.max(24, this.size * 0.12))
        const here = this.#sectionBox(this.#view)
        // 还在当前章附近就不要换。章界上高度来回补几像素时，章节名会闪个不停
        if (anchor >= here.top - 20 && anchor < here.bottom + 20) return
        let found = null
        for (const [index, view] of [...this.#spine.entries()].sort((a, b) => a[0] - b[0])) {
            const box = this.#sectionBox(view)
            if (anchor >= box.top && anchor < box.bottom) {
                found = index
                break
            }
        }
        if (found == null || found === this.#index) return
        const view = this.#spine.get(found)
        if (!view) return
        this.#view = view
        this.#index = found
        this.#afterScroll('scroll')
        void this.#extendScrolled(1)
        void this.#extendScrolled(-1)
        this.#trimScrolled()
    }
    /** 快到章界时把下一章接上，而不是滚到底再整页换掉 */
    #continueScrolled(dir) {
        if (this.#suppressContinue || this.#locked) return
        if (!this.scrolled || !this.#view) return
        if (!(this.size > 0) || !(this.viewSize > 0)) return
        if (this.#adjacentIndex(dir) == null) return
        const remain = dir > 0 ? this.viewSize - this.end : this.start
        if (remain > this.size * 1.2) return
        void this.#extendScrolled(dir)
    }
    #onUserScroll() {
        if (this.#suppressContinue || this.#container?.dataset.sparkMeasure) return
        if (!this.scrolled || this.#locked) {
            this.#scrollTick = this.#absScroll()
            return
        }
        // 用容器的滚动距离判断方向。换成下一章后 start 会从章末跳回 0，看起来像往回滑了一大截
        const scroll = this.#absScroll()
        const delta = scroll - this.#scrollTick
        this.#scrollTick = scroll
        this.#followScrolled()
        this.#scrollTick = this.#absScroll()
        if (delta > 0.5) this.#continueScrolled(1)
        else if (delta < -0.5) this.#continueScrolled(-1)
    }
    /** 章比屏幕短、或已经贴着章末再拽时，容器不会再滚动，靠这一下换章 */
    #watchSectionEdge(doc) {
        let x = 0
        let y = 0
        doc.addEventListener('touchstart', e => {
            if (!this.scrolled) return
            const t = e.changedTouches[0]
            if (!t) return
            x = t.screenX
            y = t.screenY
        }, { passive: true })
        doc.addEventListener('touchend', e => {
            if (!this.scrolled) return
            const t = e.changedTouches[0]
            if (!t) return
            const dx = x - t.screenX
            const dy = y - t.screenY
            if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.2) return
            this.#continueScrolled(dy > 0 ? 1 : -1)
        }, { passive: true })
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        this.#resetCrossScroll()
        const { scrollProp, size } = this
        if (element[scrollProp] === offset) {
            this.#scrollTick = this.#absScroll()
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, 300, easeOutQuad,
            x => this.#setScroll(element, scrollProp, x),
        ).then(() => {
            this.#scrollTick = this.#absScroll()
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            this.#setScroll(element, scrollProp, offset)
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(this.#flowOffset(anchor * this.viewSize), reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            let view = this.#takeSpare(index)
            if (view) {
                this.#discardPendingView()
                this.#pendingView = view
                onLoad?.({ doc: view.document, index })
            } else {
                view = this.#createView()
                const afterLoad = doc => {
                    // the new view is not `this.#view` yet, so `setStyles` in
                    // `onLoad` would only reach the old one
                    this.#prepareDoc(doc)
                    onLoad?.({ doc, index })
                }
                const beforeRender = this.#beforeRender.bind(this)
                await view.load(src, afterLoad, beforeRender)
                // laying the page out starts loading its fonts; show it once they
                // are ready (but never wait long) so the text does not pop in
                await Promise.race([view.document?.fonts?.ready, wait(1000)])
            }
            // `#index` follows the visible view, so it changes together with it
            if (!this.#swapView(view)) return
            this.#index = index
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
        } else this.#index = index
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        // fonts finishing after the swap can expand the page once more
        if (src && this.#view?.document?.fonts) {
            await Promise.race([this.#view.document.fonts.ready, wait(400)])
        }
        if (hasFocus) this.focusView()
        if (this.scrolled) this.#adoptScrolled()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select}) {
        this.unpeek()
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 12) return this.#scrollTo(
                this.#flowOffset(Math.max(0, this.start - (distance ?? this.size))), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 12) return this.#scrollTo(
                this.#flowOffset(Math.min(this.viewSize, distance ? this.start + distance : this.end)), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        let shouldGo = false
        try {
            this.unpeek()
            const prev = dir === -1
            shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            // 同一章里翻页是瞬间换的。这里再等 100ms 会把锁占住，快滑时下一页就慢一拍
            if (shouldGo) await wait(100)
        } finally {
            this.#locked = false
            this.#scrollTick = this.#absScroll()
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.scrolled && this.#spine.size) {
            return [...this.#spine.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([index, view]) => ({
                    index,
                    overlayer: view.overlayer,
                    doc: view.document,
                }))
        }
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    #applyStyles(doc) {
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return false
        const styles = this.#styles
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles
        return true
    }
    setStyles(styles) {
        // preloaded sections were laid out with the old styles
        if (styles !== this.#styles) this.#dropSpares()
        this.#styles = styles
        const views = []
        if (this.#pendingView) views.push(this.#pendingView)
        if (this.#view) views.push(this.#view)
        for (const view of this.#spine.values()) if (!views.includes(view)) views.push(view)
        let applied = false
        for (const view of views) {
            if (!view?.document || !this.#applyStyles(view.document)) continue
            applied = true
            // 上下滚动里前后章也要跟着字号、行距重排，不然只有当前章是阅读设置
            if (this.scrolled && view.element?.isConnected && view.element.style.position !== 'absolute')
                view.expand()
        }
        if (!applied) return

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() => {
            const doc = this.#view?.document
            if (doc) this.#paintBackground(getBackground(doc))
        })

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => this.#view?.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#discardPendingView()
        this.#dropSpares()
        this.#view.destroy()
        this.#view = null
        this.sections[this.#index]?.unload?.()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
