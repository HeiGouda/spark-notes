const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom', 'pan']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #panX = 0
    #panY = 0
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: block;
            overflow: hidden;
            touch-action: none;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value != null && value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
            case 'pan':
                this.#applyPan()
                break
        }
    }
    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    #applyPan() {
        const panX = Number(this.dataset.panX) || 0
        const panY = Number(this.dataset.panY) || 0
        for (const frame of [this.#left, this.#center, this.#right]) {
            if (frame?.element) frame.element.style.transform = `translate(${panX}px, ${panY}px)`
        }
    }
    #sheet() {
        if (this.#center?.element) return this.#center
        const side = this.#side === 'left' ? this.#left : this.#right
        if (side?.element) return side
        return this.#left?.element ? this.#left : this.#right
    }
    /** 手指在页面上的相对位置，用来让缩放绕着捏合中心转 */
    focal(clientX, clientY) {
        const rect = this.#sheet()?.element?.getBoundingClientRect()
        if (!rect || rect.width < 1 || rect.height < 1) return { fx: 0.5, fy: 0.5 }
        return {
            fx: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
            fy: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
        }
    }
    /** 只变换 iframe 里面的 canvas。变换 iframe 本身时，WebView 会留一张旧快照，拖动就有残影 */
    #pageCanvas() {
        return this.#sheet()?.iframe?.contentDocument?.querySelector('#canvas canvas') ?? null
    }
    previewScale(ratio, fx, fy, dx, dy) {
        const canvas = this.#pageCanvas()
        if (!canvas) return
        canvas.style.transformOrigin = `${fx * 100}% ${fy * 100}%`
        canvas.style.transform = `translate3d(${-this.#panX + dx}px, ${-this.#panY + dy}px, 0) scale(${ratio})`
    }
    panNow() {
        return { x: this.#panX, y: this.#panY }
    }
    panTo(x, y) {
        this.#panX = x
        this.#panY = y
        this.#applyPanTransform()
    }
    #zoomed() {
        const fit = Number(this.dataset.fitScale) || 0
        return typeof this.#zoom === 'number' && !isNaN(this.#zoom) && fit > 0 && this.#zoom > fit * 1.02
    }
    #applyPanTransform() {
        const canvas = this.#pageCanvas()
        const el = this.#sheet()?.element
        if (!canvas || !el) return
        const view = this.getBoundingClientRect()
        const maxX = Math.max(0, el.offsetWidth - view.width)
        const maxY = Math.max(0, el.offsetHeight - view.height)
        this.#panX = Math.min(maxX, Math.max(0, this.#panX))
        this.#panY = Math.min(maxY, Math.max(0, this.#panY))
        el.style.transform = 'none'
        if (maxX <= 0 && maxY <= 0) {
            canvas.style.transform = 'none'
            return
        }
        canvas.style.transformOrigin = '0 0'
        canvas.style.transform = `translate3d(${-this.#panX}px, ${-this.#panY}px, 0)`
    }
    #clearPreview() {
        const canvas = this.#pageCanvas()
        if (canvas) canvas.style.transform = 'none'
        const el = this.#sheet()?.element
        if (el) el.style.transform = 'none'
    }
    /** 双指平移但倍数没变时，把预览的位移收成页面偏移 */
    nudge(dx, dy) {
        this.#panX -= dx
        this.#panY -= dy
        this.#applyPanTransform()
    }
    /**
     * 把放大倍数落到排版上，并让 (fx, fy) 仍留在手指下。
     * 缩回整页时去掉倍数，页面重新居中。
     */
    commitZoom(zoom, fx, fy, clientX, clientY) {
        this.#clearPreview()
        const fit = Number(this.dataset.fitScale) || 0
        const snapped = fit > 0 && zoom <= fit * 1.02
        if (snapped) {
            this.#panX = 0
            this.#panY = 0
            if (this.hasAttribute('zoom')) this.removeAttribute('zoom')
            else this.#render()
            return
        }
        const text = String(zoom)
        if (this.getAttribute('zoom') !== text) this.setAttribute('zoom', text)
        else this.#render()
        const el = this.#sheet()?.element
        if (!el) return
        const host = this.getBoundingClientRect()
        this.#panX = fx * el.offsetWidth - (clientX - host.left)
        this.#panY = fy * el.offsetHeight - (clientY - host.top)
        this.#applyPanTransform()
    }
    #render(side = this.#side) {
        if (!side) return
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const view = this.getBoundingClientRect()
        const viewW = view.width
        const viewH = view.height
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && viewH > viewW
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const fitWidth = portrait || this.#center
            ? viewW / (target.width ?? blankWidth)
            : viewW / ((left.width ?? blankWidth) + (right.width ?? blankWidth))
        const fitPage = portrait || this.#center
            ? Math.min(
                viewW / (target.width ?? blankWidth),
                viewH / (target.height ?? blankHeight))
            : Math.min(
                viewW / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                viewH / Math.max(
                    left.height ?? blankHeight,
                    right.height ?? blankHeight))
        const fit = this.#zoom === 'fit-width' ? fitWidth : fitPage
        const scale = (typeof this.#zoom === 'number' && !isNaN(this.#zoom) ? this.#zoom : fit) || 1
        if (Number.isFinite(fit) && fit > 0) this.dataset.fitScale = String(fit)
        if (Number.isFinite(scale) && scale > 0) this.dataset.pageScale = String(scale)

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            if (onZoom) {
                const drawn = onZoom({ doc: frame.iframe.contentDocument, scale })
                Promise.resolve(drawn).then(() => {
                    if (this.#zoomed()) this.#applyPanTransform()
                })
            }
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            let pageW = (width ?? blankWidth) * scale
            let pageH = (height ?? blankHeight) * scale
            if (!(pageW > viewW + 0.5)) pageW = Math.min(pageW, viewW)
            if (!(pageH > viewH + 0.5)) pageH = Math.min(pageH, viewH)
            const ox = Math.max(0, (viewW - pageW) / 2)
            const oy = Math.max(0, (viewH - pageH) / 2)
            Object.assign(element.style, {
                width: `${pageW}px`,
                height: `${pageH}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                margin: '0',
                marginLeft: `${ox}px`,
                marginTop: `${oy}px`,
                transform: 'none',
                backfaceVisibility: 'hidden',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
        this.style.overflow = 'hidden'
        if (this.#zoomed()) this.#applyPanTransform()
        else {
            this.#panX = 0
            this.#panY = 0
        }
    }
    async #showSpread({ left, right, center, side }) {
        this.#panX = 0
        this.#panY = 0
        this.scrollLeft = 0
        this.scrollTop = 0
        this.#root.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side
            this.#render()
        }
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#reportLocation(reason)
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents() {
        return Array.from(this.#root.querySelectorAll('iframe'), frame => ({
            doc: frame.contentDocument,
            // TODO: index, overlayer
        }))
    }
    destroy() {
        this.#observer.unobserve(this)
    }
}

customElements.define('foliate-fxl', FixedLayout)
