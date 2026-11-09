import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	TILE_COLS,
	TILE_ROWS,
	type SheetId,
	type SheetLayout,
	type SheetRange
} from "../../core/sheet/protocol"
import {
	decoratePane,
	decoratorInset,
	NO_EXTENSIONS,
	paintLayers,
	paintScene,
	sameParts,
	type GridExtensionParts,
	type GridRect
} from "./layers"
import { EXTRA_COLS, EXTRA_ROWS, type GridAxes, type SheetGridModel } from "./model"
import { BorderPainter } from "./paint/borders"
import type { GridCanvas } from "./paint/canvas"
import { paintCells, TEXT_PADDING } from "./paint/cells"
import { CLIP_DASH_PERIOD, paintChrome, type ChromeScene } from "./paint/chrome"
import { canvasSwatches, PatternCache } from "./paint/patterns"
import { TextMeasurer, textFont } from "./paint/text"
import { domExtent, toDom, toVirtual } from "./scroll"
import type { GridPoint } from "./selection"
import { readTheme } from "./readTheme"
import { DEFAULT_THEME, type SheetGridTheme } from "./theme"
import { bodyTotal, gridView, hitAxis, revealOffset, screenOf, edgeAt, type GridView } from "./view"

// Draws a grid on two canvases (cells; headers and selection over them) at most once a frame, sized to the
// scroller's viewport. The scroller holds only an empty extent element, so the browser scrolls nothing it has to
// paint; each scroll event maps the scroll position to the sheet's (scroll.ts) and asks for a frame. The frame
// fetches the tiles it lacks (they paint in a later frame), positions the editor and the accessible active cell,
// and grows the extent when the user scrolled to its end.
//
// A right-to-left sheet (SheetLayout.rightToLeft) is laid out as any other and shown mirrored: the painters
// mirror what they draw, hit-testing mirrors the pointer, and the scroller's horizontal offset runs from its end,
// so the scrollbar starts at the right and dragging it left brings in the columns past the left edge.
//
// Canvas rather than rows of memoised cell elements: both cost about the same for a step of a few rows, but a step
// that replaces the window (a page, a jump, a fast fling) makes the DOM build and lay out every cell again, several
// times the canvas's draw in Chromium (and past a frame on a slow CPU); and a canvas draws every border style,
// diagonals and turned text, which CSS borders cannot.

export interface GridElements {
	readonly root: HTMLElement
	readonly scroller: HTMLElement
	readonly extent: HTMLElement
	readonly cells: HTMLCanvasElement
	readonly chrome: HTMLCanvasElement
	// The accessible active cell, kept over the real one.
	readonly active: HTMLElement
}

export type GridHit =
	| { readonly kind: "cell"; readonly row: number; readonly col: number }
	| { readonly kind: "colHeader"; readonly col: number; readonly edge: number | null }
	| { readonly kind: "rowHeader"; readonly row: number; readonly edge: number | null }
	| { readonly kind: "corner" }

interface Scroll {
	top: number
	left: number
	// The browser's offsets the virtual ones were last set from, to tell our own scrolling from the user's.
	domTop: number
	domLeft: number
}

// Tile rows and columns fetched past the edges of what is on screen.
const MARGIN_ROWS = 16
const MARGIN_COLS = 8
// Rows (columns) left before the extent's end that make it grow.
const GROW_SLACK = 8
// The smallest font iOS focuses a field in without zooming the page (WebKit: text fields under 16 px zoom).
const TOUCH_FONT_PX = 16
// A scroll this long without another event has settled (a momentum's frames come 16 ms apart).
const SCROLL_IDLE_MS = 150
// A step of the copy's moving border.
const CLIP_STEP_MS = 100

// The browser's scroll range for a scrolled part.
function domRange(view: GridView["rows"]): number {
	return Math.max(0, domExtent(bodyTotal(view)) - view.bodyView)
}

function withinScroll(dom: number, view: GridView["rows"]): number {
	return Math.max(0, Math.min(domRange(view), dom))
}

// A scrolled part's offset moved by `delta` of the sheet's own pixels, kept within its range. The browser's offset at
// the start of its range is the sheet's start, and at its end the sheet's last row (column) once the extent holds
// them all (`cap`): a pan that ran out of scroller has reached it. scroll.ts maps both ends one to one, so this is no
// jump unless the pan started deep in a scaled middle. Short of the cap the extent grows as the view nears its end,
// and the settled pan's offsets leave the next one room.
function panned(offset: number, dom: number, delta: number, view: GridView["rows"], cap: number): number {
	const range = Math.max(0, bodyTotal(view) - view.bodyView)

	if (dom <= 0) return 0
	if (dom >= domRange(view) - 1 && view.axis.count >= cap) return range

	return Math.max(0, Math.min(range, offset + delta))
}

// The inputs of a cells paint, compared by identity. The view is read through its own inputs (axes, layout, its
// scroll and size).
interface DrawnCells {
	readonly version: number
	readonly sheet: SheetId
	readonly layout: SheetLayout
	readonly axes: GridAxes
	readonly top: number
	readonly left: number
	readonly width: number
	readonly height: number
	readonly pixelRatio: number
	readonly theme: SheetGridTheme
	readonly parts: GridExtensionParts
}

export class GridRenderer {
	private elements: GridElements | null = null
	private cells: GridCanvas | null = null
	private chrome: GridCanvas | null = null
	private measurer: TextMeasurer | null = null
	private borders: BorderPainter | null = null
	private readonly patterns = new PatternCache(canvasSwatches())
	private theme: SheetGridTheme = DEFAULT_THEME
	// The variables changed (or may have): read again when next used. An app moves its theme class in an effect of
	// its own, which runs after the grid's, so they are read at the frame, not at once.
	private themeStale = false
	private frame = 0
	private width = 0
	private height = 0
	private pixelRatio = 1
	private readonly scroll: Scroll = { top: 0, left: 0, domTop: 0, domLeft: 0 }
	// Fingers on the scroller, and whether the scrolling since the last pause is theirs (a pan, then its momentum):
	// such a scroll moves the sheet by the pixels it moves, not by the scaled mapping.
	private touches = 0
	private panning = false
	// A mouse or pen button held on the scroller (its scrollbar's thumb, a selection dragged past the edge): the
	// extent does not shrink under it.
	private pressed = false
	// Whether a finger may be what edits (any coarse pointer): the editor's font stays at 16 px or more there.
	private coarse: MediaQueryList | null = null
	// The user asks for less motion: the copy's border holds still.
	private stillMotion: MediaQueryList | null = null
	// The last frame's chrome scene, which the copy's moving border steps redraw; its timer.
	private chromeScene: ChromeScene | null = null
	private clipTimer: ReturnType<typeof setInterval> | undefined = undefined
	private idle: ReturnType<typeof setTimeout> | undefined = undefined
	private sheet: SheetId | null = null
	// Each sheet's scroll position when the user left it.
	private readonly scrolls = new Map<SheetId, { top: number; left: number }>()
	private view: GridView | null = null
	private extentWidth = -1
	private extentHeight = -1
	private readonly detach: (() => void)[] = []
	// The editor's box, placed over its cell on every frame while it is open.
	private editor: HTMLElement | null = null
	// A resize's guide: the edge after `index`.
	private guide: { axis: "rows" | "cols"; index: number } | null = null
	// What a fill-handle drag would fill (or keep, dragged back inside the selection).
	private fill: SheetRange | null = null
	// The extensions' layers and decorators (layers.ts), and who hears of each frame (overlays re-placing).
	private parts: GridExtensionParts = NO_EXTENSIONS
	private inset: ((flags: number) => number) | undefined = undefined
	private readonly frameListeners = new Set<() => void>()
	// What the cells canvas shows was drawn from: a frame whose inputs all match draws the chrome only (a selection
	// move, an entry's keystroke). Null: the canvas holds nothing drawn (attached, resized, blanked).
	private drawn: DrawnCells | null = null
	// Frame costs (ms), for the perf harness.
	readonly costs: number[] = []
	measure = false

	private readonly model: SheetGridModel

	constructor(model: SheetGridModel) {
		this.model = model
	}

	attach(elements: GridElements): void {
		this.dispose()
		this.elements = elements
		this.cells = elements.cells.getContext("2d")
		this.chrome = elements.chrome.getContext("2d")

		if (this.cells !== null) {
			this.measurer = new TextMeasurer(this.cells)
			this.borders = new BorderPainter(this.cells)
		}

		this.theme = readTheme(elements.root)
		this.themeStale = false

		const onScroll = (): void => {
			this.readScroll()
			this.schedule()
			this.waitIdle()
		}
		// Touch events go on through the browser's own pan (pointer events end at its start with pointercancel). A
		// move counts the fingers too: a browser may send no touchstart for a pan it started itself (Chromium's
		// synthetic gestures), only its pointerdown.
		const onTouchStart = (event: TouchEvent): void => {
			this.touches = event.touches.length
			this.panning = true
		}
		const onTouchEnd = (event: TouchEvent): void => {
			this.touches = event.touches.length

			if (this.touches === 0) this.waitIdle()
		}
		const onPress = (event: PointerEvent): void => {
			if (event.pointerType !== "touch") {
				this.pressed = true
			} else {
				this.touches = Math.max(1, this.touches)
				this.panning = true
			}
		}
		const onRelease = (): void => {
			if (!this.pressed) return

			this.pressed = false
			this.waitIdle()
		}
		const view = elements.scroller.ownerDocument.defaultView
		const resize = new ResizeObserver(() => {
			this.readSize()
			this.schedule()
		})

		// Past the browsers' scroll range a wheel step would move the sheet by the scaled distance: it moves it by its
		// own instead (scroll.ts). Not passive, so it can take the step; a pinch (Ctrl+wheel) stays the page's.
		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && this.wheel(event)) event.preventDefault()
		}

		elements.scroller.addEventListener("scroll", onScroll, { passive: true })
		elements.scroller.addEventListener("wheel", onWheel, { passive: false })
		elements.scroller.addEventListener("touchstart", onTouchStart, { passive: true })
		elements.scroller.addEventListener("touchmove", onTouchStart, { passive: true })
		elements.scroller.addEventListener("touchend", onTouchEnd, { passive: true })
		elements.scroller.addEventListener("touchcancel", onTouchEnd, { passive: true })
		elements.scroller.addEventListener("pointerdown", onPress, { passive: true })
		view?.addEventListener("pointerup", onRelease, { passive: true, capture: true })
		view?.addEventListener("pointercancel", onRelease, { passive: true, capture: true })
		resize.observe(elements.scroller)
		this.detach.push(
			() => elements.scroller.removeEventListener("scroll", onScroll),
			() => elements.scroller.removeEventListener("wheel", onWheel),
			() => elements.scroller.removeEventListener("touchstart", onTouchStart),
			() => elements.scroller.removeEventListener("touchmove", onTouchStart),
			() => elements.scroller.removeEventListener("touchend", onTouchEnd),
			() => elements.scroller.removeEventListener("touchcancel", onTouchEnd),
			() => elements.scroller.removeEventListener("pointerdown", onPress),
			() => view?.removeEventListener("pointerup", onRelease, { capture: true }),
			() => view?.removeEventListener("pointercancel", onRelease, { capture: true }),
			() => clearTimeout(this.idle),
			() => this.animateClip(false),
			() => resize.disconnect(),
			this.model.onPaint(() => this.schedule())
		)
		this.coarse = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(any-pointer: coarse)") : null
		this.stillMotion = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : null
		// A theme that follows the system's scheme changes the variables without the app saying so.
		if (typeof globalThis.matchMedia === "function") {
			const scheme = globalThis.matchMedia("(prefers-color-scheme: dark)")
			const onScheme = (): void => this.refreshTheme()

			scheme.addEventListener("change", onScheme)
			this.detach.push(() => scheme.removeEventListener("change", onScheme))
		}

		this.readSize()
		this.restoreScroll()
		this.paint()
	}

	dispose(): void {
		for (const detach of this.detach.splice(0)) detach()

		if (this.frame !== 0) cancelAnimationFrame(this.frame)

		this.frame = 0
		this.elements = null
		this.drawn = null
	}

	refreshTheme(): void {
		if (this.elements === null) return

		this.themeStale = true
		this.schedule()
	}

	private currentTheme(): SheetGridTheme {
		if (this.themeStale && this.elements !== null) {
			this.themeStale = false
			this.theme = readTheme(this.elements.root)
			this.measurer?.reset()
		}

		return this.theme
	}

	// Placed at once, so it never shows a frame away from its cell.
	setEditor(editor: HTMLElement | null): void {
		this.editor = editor

		const view = this.view

		if (view !== null && editor !== null) this.place(view, this.model.getSnapshot().selection.active)
	}

	// A list with the same parts (a parent's render rebuilding it) repaints nothing.
	setExtensions(parts: GridExtensionParts): void {
		if (sameParts(parts, this.parts)) return

		this.parts = parts
		this.inset = decoratorInset(parts.decorators)
		this.schedule()
	}

	// Called after every frame drawn: what an overlay placed over a cell reads again (cellRect).
	onFrame(listener: () => void): () => void {
		this.frameListeners.add(listener)

		return () => {
			this.frameListeners.delete(listener)
		}
	}

	setFillPreview(range: SheetRange | null): void {
		this.fill = range
		this.schedule()
	}

	setGuide(guide: { axis: "rows" | "cols"; index: number } | null): void {
		this.guide = guide
		this.schedule()
	}

	schedule(): void {
		if (this.frame === 0 && this.elements !== null) this.frame = requestAnimationFrame(() => this.paint())
	}

	private readSize(): void {
		const scroller = this.elements?.scroller

		if (scroller === undefined) return

		this.width = scroller.clientWidth
		this.height = scroller.clientHeight
	}

	// The current sheet is shown right to left.
	private mirrored(): boolean {
		return this.model.layout(this.model.getSnapshot().sheet)?.rightToLeft === true
	}

	// The scroller's horizontal offset as laid out: from its end in a mirrored sheet.
	private laidOutLeft(scroller: HTMLElement): number {
		return this.mirrored() ? Math.max(0, scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft) : scroller.scrollLeft
	}

	// Keeps the virtual offsets when the browser's are what we set them to (rounding would move them otherwise). A
	// finger's pan moves the sheet one pixel per pixel, as on any other sheet; the scrollbar maps by position.
	private readScroll(): void {
		const scroller = this.elements?.scroller

		if (scroller === undefined || this.view === null) return

		// iOS reports offsets past either end while it bounces (a rubber band): the sheet stays at the end meanwhile.
		const top = withinScroll(scroller.scrollTop, this.view.rows)
		const left = withinScroll(this.laidOutLeft(scroller), this.view.cols)

		if (Math.abs(top - this.scroll.domTop) >= 1) {
			this.scroll.top = this.panning
				? panned(this.scroll.top, top, top - this.scroll.domTop, this.view.rows, SHEET_MAX_ROWS)
				: toVirtual(top, bodyTotal(this.view.rows), this.view.rows.bodyView)
			this.scroll.domTop = top
		}

		if (Math.abs(left - this.scroll.domLeft) >= 1) {
			this.scroll.left = this.panning
				? panned(this.scroll.left, left, left - this.scroll.domLeft, this.view.cols, SHEET_MAX_COLS)
				: toVirtual(left, bodyTotal(this.view.cols), this.view.cols.bodyView)
			this.scroll.domLeft = left
		}
	}

	// Restarts the wait for the scroll to settle (no scroll event and no finger down for SCROLL_IDLE_MS).
	private waitIdle(): void {
		clearTimeout(this.idle)
		this.idle = setTimeout(() => {
			this.idle = undefined

			if (this.touches === 0 && !this.pressed) this.settle()
		}, SCROLL_IDLE_MS)
	}

	// A settled scroll: a pan's browser offsets are set again from the sheet's (they drifted from the scaled mapping
	// while it moved one to one), and the extent gives back the blank rows and columns the view has left behind.
	private settle(): void {
		const sheet = this.model.getSnapshot().sheet
		const view = this.view

		if (view === null) return

		if (this.panning) {
			this.panning = false
			this.writeScroll()
		}

		// No nearer than growIfAtEnd's slack to the end, so the extent does not grow straight back.
		this.model.shrink(sheet, view.rows.last + GROW_SLACK - EXTRA_ROWS, view.cols.last + GROW_SLACK - EXTRA_COLS)
	}

	// A sheet opens where the user left it in this session, else where its file did: the scrolled pane's first cell
	// at the top left.
	private restoreScroll(): void {
		const sheet = this.model.getSnapshot().sheet
		const layout = this.model.layout(sheet)
		const axes = this.model.axes(sheet)

		if (layout === null || axes === null) return

		if (this.sheet !== null) this.scrolls.set(this.sheet, { top: this.scroll.top, left: this.scroll.left })

		this.sheet = sheet

		const kept = this.scrolls.get(sheet)
		const pane = layout.pane
		// The scrolled part starts past the frozen block.
		const bodyRow = pane === null ? 0 : pane.rows > 0 ? pane.firstRow + pane.rows : 0
		const bodyCol = pane === null ? 0 : pane.cols > 0 ? pane.firstCol + pane.cols : 0

		this.scroll.top = kept?.top ?? (pane === null ? 0 : Math.max(0, axes.rows.offset(pane.topRow) - axes.rows.offset(bodyRow)))
		this.scroll.left = kept?.left ?? (pane === null ? 0 : Math.max(0, axes.cols.offset(pane.leftCol) - axes.cols.offset(bodyCol)))
		this.view = this.computeView()
		this.writeScroll()
	}

	private computeView(): GridView | null {
		const sheet = this.model.getSnapshot().sheet
		const layout = this.model.layout(sheet)
		const axes = this.model.axes(sheet)

		if (layout === null || axes === null) return null

		return gridView(axes, layout, this.scroll, this.width, this.height)
	}

	// The extent element sized for the view, then the browser's offsets set from the virtual ones.
	private writeScroll(): void {
		const elements = this.elements
		const view = this.view

		if (elements === null || view === null) return

		this.sizeExtent(view)

		const top = toDom(view.rows.scroll, bodyTotal(view.rows), view.rows.bodyView)
		const left = toDom(view.cols.scroll, bodyTotal(view.cols), view.cols.bodyView)

		this.scroll.top = view.rows.scroll
		this.scroll.left = view.cols.scroll
		elements.scroller.scrollTop = top
		elements.scroller.scrollLeft = this.mirrored()
			? Math.max(0, elements.scroller.scrollWidth - elements.scroller.clientWidth - left)
			: left
		this.scroll.domTop = elements.scroller.scrollTop
		this.scroll.domLeft = this.laidOutLeft(elements.scroller)
	}

	// Whether the extent's size changed.
	private sizeExtent(view: GridView): boolean {
		const extent = this.elements?.extent

		if (extent === undefined) return false

		const width = Math.ceil(view.cols.header + view.cols.frozenSize + domExtent(bodyTotal(view.cols)))
		const height = Math.ceil(view.rows.header + view.rows.frozenSize + domExtent(bodyTotal(view.rows)))
		const changed = width !== this.extentWidth || height !== this.extentHeight

		if (width !== this.extentWidth) {
			extent.style.width = `${String(width)}px`
			this.extentWidth = width
		}

		if (height !== this.extentHeight) {
			extent.style.height = `${String(height)}px`
			this.extentHeight = height
		}

		return changed
	}

	currentView(): GridView | null {
		return this.view
	}

	paint(): void {
		this.frame = 0

		const elements = this.elements

		if (elements === null) return

		const started = this.measure ? performance.now() : 0
		const snapshot = this.model.getSnapshot()

		if (snapshot.sheet !== this.sheet) this.restoreScroll()

		const layout = this.model.layout(snapshot.sheet)
		const axes = this.model.axes(snapshot.sheet)
		const theme = this.currentTheme()
		const pixelRatio = Math.max(1, Math.min(4, globalThis.devicePixelRatio || 1))

		this.resizeCanvases(pixelRatio)

		if (layout === null || axes === null) {
			this.chromeScene = null
			this.animateClip(false)
			this.blank()

			return
		}

		const view = gridView(axes, layout, this.scroll, this.width, this.height)

		this.view = view

		// A grown or shrunk extent changes what a scaled browser offset means: the browser's follows the sheet's. Not
		// under a finger's pan, which moves by deltas and takes no offset written while the browser scrolls (Chromium
		// goes on from its own): its offsets are set again once it settles.
		if (this.sizeExtent(view) && !this.panning) this.writeScroll()

		this.requestTiles(snapshot.sheet, view)

		const parts = this.parts
		const extended = parts.decorators.length > 0 || parts.cellLayers.length > 0 || parts.chromeLayers.length > 0
		const scene = extended
			? paintScene({
					model: this.model,
					sheet: snapshot.sheet,
					layout,
					view,
					theme,
					scale: axes.scale,
					pixelRatio,
					rightToLeft: layout.rightToLeft
				})
			: null

		const version = this.model.cellsVersion()
		const drawn = this.drawn
		// A cells-stage layer is a whole pass that may read anything, so it draws on every frame; decorators mark tile
		// entries, which move the model's cells version when they change.
		const current =
			drawn !== null &&
			parts.cellLayers.length === 0 &&
			drawn.version === version &&
			drawn.sheet === snapshot.sheet &&
			drawn.layout === layout &&
			drawn.axes === axes &&
			drawn.top === view.rows.scroll &&
			drawn.left === view.cols.scroll &&
			drawn.width === view.width &&
			drawn.height === view.height &&
			drawn.pixelRatio === pixelRatio &&
			drawn.theme === theme &&
			drawn.parts === parts

		if (!current && this.cells !== null && this.measurer !== null && this.borders !== null) {
			const cells = this.cells

			// Cleared first: a paint that throws leaves the canvas to be drawn again.
			this.drawn = null
			paintCells(
				{ canvas: cells, measurer: this.measurer, borders: this.borders, patterns: this.patterns },
				{ model: this.model, sheet: snapshot.sheet, layout, view, theme, scale: axes.scale, pixelRatio, inset: this.inset },
				scene === null ? undefined : (rows, cols) => decoratePane(cells, scene, parts.decorators, "under", rows, cols)
			)

			if (scene !== null) {
				for (const pane of scene.panes) decoratePane(cells, scene, parts.decorators, "over", pane.rows, pane.cols)

				paintLayers(cells, scene, parts.cellLayers)
			}

			// The version read before the paint: anything that moved it meanwhile draws again next frame.
			this.drawn = {
				version,
				sheet: snapshot.sheet,
				layout,
				axes,
				top: view.rows.scroll,
				left: view.cols.scroll,
				width: view.width,
				height: view.height,
				pixelRatio,
				theme,
				parts
			}
		}

		const mark = this.model.clipMark()
		const clipRange = mark !== null && mark.sheet === snapshot.sheet && !this.model.cellless(snapshot.sheet) ? mark.range : null

		this.chromeScene = null
		this.animateClip(clipRange !== null)

		if (this.chrome !== null) {
			const chrome = this.chrome

			this.chromeScene = {
				overSelection: scene === null ? undefined : () => paintLayers(chrome, scene, parts.chromeLayers),
				fill: this.fill,
				clip: clipRange === null ? null : { range: clipRange, offset: this.clipOffset() },
				view,
				theme,
				pixelRatio,
				rightToLeft: layout.rightToLeft,
				selection: this.model.cellless(snapshot.sheet) ? null : snapshot.selection,
				merges: this.model.merges(layout),
				guide:
					this.guide === null
						? null
						: {
								axis: this.guide.axis,
								at:
									screenOf(this.guide.axis === "rows" ? view.rows : view.cols, this.guide.index) +
									(this.guide.axis === "rows" ? view.rows : view.cols).axis.size(this.guide.index)
							}
			}
			paintChrome(chrome, this.chromeScene)
		}

		this.place(view, snapshot.selection.active)
		this.growIfAtEnd(snapshot.sheet, view)

		for (const listener of this.frameListeners) listener()

		if (this.measure) this.costs.push(performance.now() - started)
	}

	// The copy's moving border steps on a timer while it shows on the sheet shown, redrawing the chrome layer alone
	// with the last frame's scene: a step is a few strokes, never the cells. Still where the user asks for less motion,
	// and idle while the page is hidden.
	private animateClip(on: boolean): void {
		const still = this.stillMotion?.matches === true

		if (on && !still) {
			this.clipTimer ??= setInterval(() => this.stepClip(), CLIP_STEP_MS)
		} else if (this.clipTimer !== undefined) {
			clearInterval(this.clipTimer)
			this.clipTimer = undefined
		}
	}

	private clipOffset(): number {
		return this.stillMotion?.matches === true ? 0 : Math.floor(performance.now() / CLIP_STEP_MS) % CLIP_DASH_PERIOD
	}

	private stepClip(): void {
		const scene = this.chromeScene
		const chrome = this.chrome

		// A frame on its way draws the border at its step anyway.
		if (scene === null || chrome === null || this.frame !== 0 || scene.clip === undefined || scene.clip === null) return
		if (this.elements?.root.ownerDocument.visibilityState === "hidden") return

		this.chromeScene = { ...scene, clip: { range: scene.clip.range, offset: this.clipOffset() } }
		paintChrome(chrome, this.chromeScene)
	}

	private blank(): void {
		const theme = this.currentTheme()

		this.drawn = null

		for (const canvas of [this.cells, this.chrome]) {
			if (canvas === null) continue

			canvas.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
			canvas.fillStyle = canvas === this.cells ? theme.background : "rgba(0,0,0,0)"
			canvas.fillRect(0, 0, this.width, this.height)
		}
	}

	private resizeCanvases(pixelRatio: number): void {
		const elements = this.elements

		if (elements === null) return

		const width = Math.max(1, Math.round(this.width * pixelRatio))
		const height = Math.max(1, Math.round(this.height * pixelRatio))

		if (elements.cells.width === width && elements.cells.height === height && this.pixelRatio === pixelRatio) return

		this.pixelRatio = pixelRatio

		for (const canvas of [elements.cells, elements.chrome]) {
			canvas.width = width
			canvas.height = height
			canvas.style.width = `${String(this.width)}px`
			canvas.style.height = `${String(this.height)}px`
		}

		// A resized canvas loses its state and what it showed.
		this.drawn = null
		this.measurer?.reset()
		this.borders?.reset()
	}

	// The tiles under the view (frozen panes included) plus a margin, as tile row and column pairs.
	private requestTiles(sheet: SheetId, view: GridView): void {
		const rowSpans: [number, number][] = []
		const colSpans: [number, number][] = []

		if (view.rows.frozen > 0) rowSpans.push([view.rows.frozenFirst, view.rows.frozenEnd - 1])
		if (view.rows.last >= view.rows.first)
			rowSpans.push([Math.max(view.rows.frozenEnd, view.rows.first - MARGIN_ROWS), view.rows.last + MARGIN_ROWS])
		if (view.cols.frozen > 0) colSpans.push([view.cols.frozenFirst, view.cols.frozenEnd - 1])
		if (view.cols.last >= view.cols.first)
			colSpans.push([Math.max(view.cols.frozenEnd, view.cols.first - MARGIN_COLS), view.cols.last + MARGIN_COLS])

		const tileRows = new Set<number>()
		const tileCols = new Set<number>()

		for (const [first, last] of rowSpans)
			for (let tile = Math.floor(first / TILE_ROWS); tile <= Math.floor(Math.min(view.rows.axis.count - 1, last) / TILE_ROWS); tile++)
				tileRows.add(tile)
		for (const [first, last] of colSpans)
			for (let tile = Math.floor(first / TILE_COLS); tile <= Math.floor(Math.min(view.cols.axis.count - 1, last) / TILE_COLS); tile++)
				tileCols.add(tile)

		const coordinates: number[] = []

		for (const tileRow of tileRows) for (const tileCol of tileCols) coordinates.push(tileRow, tileCol)

		this.model.need(sheet, coordinates)
	}

	// The accessible active cell and the editor over the active cell.
	private place(view: GridView, active: GridPoint): void {
		const elements = this.elements

		if (elements === null) return

		// A chartsheet has no cell to stand over.
		const box = this.model.cellless() ? null : this.cellBox(view, active)
		const a11y = elements.active
		const mirrored = this.mirrored()
		// Where a box laid out from x starts on screen.
		const screenX = (x: number, width: number): number => (mirrored ? view.width - x - width : x)

		if (box === null) {
			a11y.style.transform = "translate(-9999px, 0)"
		} else {
			a11y.style.transform = `translate(${String(elements.scroller.scrollLeft + screenX(box.x, box.width))}px, ${String(this.scroll.domTop + box.y)}px)`
			a11y.style.width = `${String(box.width)}px`
			a11y.style.height = `${String(box.height)}px`
		}

		const editor = this.editor
		const editing = this.model.getSnapshot().editing

		if (editor === null || editing === null) return

		// An entry open on another sheet (pointing at this one's cells) keeps its focus off screen.
		const editBox = editing.sheet === this.model.getSnapshot().sheet ? this.cellBox(view, { row: editing.row, col: editing.col }) : null

		if (editBox === null) {
			editor.style.transform = "translate(-9999px, 0)"

			return
		}

		const layout = this.model.layout(editing.sheet)
		const found = this.model.entry(editing.sheet, editing.row, editing.col)
		const style = this.model.style(found === null ? 0 : (found.tile.styles[found.entry] ?? 0))
		const scale = layout === null ? 1 : this.model.scale(layout)

		const editX = screenX(editBox.x, editBox.width)
		const base = this.model.style(0)
		const font = textFont(style, base, this.currentTheme().font, scale)
		// iOS zooms the page to a focused field whose font is under 16 px. Where a finger may edit, the editor is laid
		// out `grow` times larger (its font at least 16 px) and drawn scaled back down, so it looks the same.
		const large =
			font.px < TOUCH_FONT_PX && this.coarse?.matches === true
				? textFont(style, base, this.currentTheme().font, scale * ((TOUCH_FONT_PX + 0.01) / font.px))
				: null
		const grow = large === null ? 1 : large.px / font.px
		const shrink = grow === 1 ? "" : ` scale(${String(1 / grow)})`

		// Mirrored, the editor keeps its cell's right edge and grows to the left.
		editor.style.transformOrigin = mirrored ? "top right" : "top left"
		editor.style.transform = mirrored
			? `translate(calc(${String(editX + editBox.width)}px - 100%), ${String(editBox.y)}px)${shrink}`
			: `translate(${String(editX)}px, ${String(editBox.y)}px)${shrink}`
		// The box's textarea takes the sizes and the padding (css/sheet.css); the font is inherited by it and its backdrop.
		editor.style.setProperty("--fo-sheet-editor-min-width", `${String(editBox.width * grow)}px`)
		editor.style.setProperty("--fo-sheet-editor-min-height", `${String(editBox.height * grow)}px`)
		editor.style.setProperty(
			"--fo-sheet-editor-max-width",
			`${String(Math.max(editBox.width, mirrored ? editX + editBox.width : view.width - editX) * grow)}px`
		)
		editor.style.setProperty("--fo-sheet-editor-padding", `${String(Math.max(1, Math.round(TEXT_PADDING * scale)) * grow)}px`)
		editor.style.font = (large ?? font).css
	}

	// A cell's (or its merge's) box as the grid's root shows it (mirrored for a right-to-left sheet), in CSS pixels
	// from the root's top left; null when it is not on screen.
	cellRect(point: GridPoint): GridRect | null {
		const view = this.view

		if (view === null) return null

		const box = this.cellBox(view, point)

		if (box === null) return null

		return this.mirrored() ? { ...box, x: view.width - box.x - box.width } : box
	}

	// A range's bottom-right corner as the root shows it (bottom-left in a right-to-left sheet), or null when it is
	// not on screen (scrolled away, or under the frozen panes).
	cornerOf(range: SheetRange): { x: number; y: number } | null {
		const view = this.view

		if (view === null) return null

		const edge = (axis: GridView["rows"], index: number): number | null => {
			const at = screenOf(axis, index) + axis.axis.size(index)
			const start = index < axis.frozenEnd ? axis.header : axis.header + axis.frozenSize

			return at <= start || at > axis.view ? null : at
		}
		const x = edge(view.cols, range.endCol)
		const y = edge(view.rows, range.endRow)

		if (x === null || y === null) return null

		return { x: this.mirrored() ? view.width - x : x, y }
	}

	// A range's top-left corner as the root shows it (top-right in a right-to-left sheet), or null when it is not on
	// screen: where a touch selection's start handle sits.
	startCornerOf(range: SheetRange): { x: number; y: number } | null {
		const view = this.view

		if (view === null) return null

		const edge = (axis: GridView["rows"], index: number): number | null => {
			const at = screenOf(axis, index)
			const start = index < axis.frozenEnd ? axis.header : axis.header + axis.frozenSize

			return at < start || at >= axis.view ? null : at
		}
		const x = edge(view.cols, range.startCol)
		const y = edge(view.rows, range.startRow)

		if (x === null || y === null) return null

		return { x: this.mirrored() ? view.width - x : x, y }
	}

	// The part of a range on screen, as the root shows it, in CSS pixels from its top left: one box round what of it
	// the panes show (null: none of it). Where a menu about the selection is anchored.
	rangeRect(range: SheetRange): GridRect | null {
		const view = this.view

		if (view === null) return null

		const span = (axis: GridView["rows"], start: number, end: number): { from: number; to: number } | null => {
			let from = Number.POSITIVE_INFINITY
			let to = Number.NEGATIVE_INFINITY
			// The frozen part, then the scrolled part, each clipped to where it shows.
			const parts: [number, number, number, number][] = [
				[axis.frozenFirst, axis.frozenEnd - 1, axis.header, axis.header + axis.frozenSize],
				[axis.first, axis.last, axis.header + axis.frozenSize, axis.view]
			]

			for (const [first, last, low, high] of parts) {
				const a = Math.max(start, first)
				const b = Math.min(end, last)

				if (a > b) continue

				from = Math.min(from, Math.max(low, screenOf(axis, a)))
				to = Math.max(to, Math.min(high, screenOf(axis, b) + axis.axis.size(b)))
			}

			return to > from ? { from, to } : null
		}
		const cols = span(view.cols, range.startCol, range.endCol)
		const rows = span(view.rows, range.startRow, range.endRow)

		if (cols === null || rows === null) return null

		const box = { x: cols.from, y: rows.from, width: cols.to - cols.from, height: rows.to - rows.from }

		return this.mirrored() ? { ...box, x: view.width - box.x - box.width } : box
	}

	// A cell's (or its merge's) box on screen, or null when it is not on screen.
	cellBox(view: GridView, point: GridPoint): { x: number; y: number; width: number; height: number } | null {
		const layout = this.model.layout(this.model.getSnapshot().sheet)
		const merge =
			layout === null
				? null
				: this.model
						.merges(layout)
						.find(
							range =>
								point.row >= range.startRow &&
								point.row <= range.endRow &&
								point.col >= range.startCol &&
								point.col <= range.endCol
						)
		const startRow = merge?.startRow ?? point.row
		const startCol = merge?.startCol ?? point.col
		const endRow = merge?.endRow ?? point.row
		const endCol = merge?.endCol ?? point.col
		const x = screenOf(view.cols, startCol)
		const y = screenOf(view.rows, startRow)
		const width = screenOf(view.cols, endCol) + view.cols.axis.size(endCol) - x
		const height = screenOf(view.rows, endRow) + view.rows.axis.size(endRow) - y

		if (
			width <= 0 ||
			height <= 0 ||
			x + width <= view.cols.header ||
			y + height <= view.rows.header ||
			x >= view.width ||
			y >= view.height
		)
			return null

		return { x, y, width, height }
	}

	private growIfAtEnd(sheet: SheetId, view: GridView): void {
		const rowsLeft = view.rows.axis.count - 1 - view.rows.last
		const colsLeft = view.cols.axis.count - 1 - view.cols.last

		if (view.rows.last >= view.rows.first && rowsLeft < GROW_SLACK) this.model.grow(sheet, view.rows.last + GROW_SLACK, 0)
		if (view.cols.last >= view.cols.first && colsLeft < GROW_SLACK) this.model.grow(sheet, 0, view.cols.last + GROW_SLACK)
	}

	// --- Hit-testing ---

	hit(clientX: number, clientY: number, slop: number): GridHit | null {
		const elements = this.elements
		const view = this.view

		if (elements === null || view === null) return null

		const rect = elements.scroller.getBoundingClientRect()
		const screenX = clientX - rect.left
		const y = clientY - rect.top

		// The scrollbars.
		if (screenX >= this.width || y >= this.height) return null

		const x = this.layoutX(screenX)

		const row = hitAxis(view.rows, y)
		const col = hitAxis(view.cols, x)

		if (row === null || col === null) return null
		if (row.part === "header" && col.part === "header") return { kind: "corner" }
		if (row.part === "header" && col.part !== "header") return { kind: "colHeader", col: col.index, edge: edgeAt(view.cols, x, slop) }
		if (col.part === "header" && row.part !== "header") return { kind: "rowHeader", row: row.index, edge: edgeAt(view.rows, y, slop) }
		if (row.part === "header" || col.part === "header") return null

		return { kind: "cell", row: row.index, col: col.index }
	}

	// A screen x in the scroller as the grid is laid out (mirrored in a right-to-left sheet).
	layoutX(x: number): number {
		return this.mirrored() ? this.width - x : x
	}

	// Where a pointer is, in the scroller's own coordinates (on screen: layoutX gives the laid-out x).
	local(clientX: number, clientY: number): { x: number; y: number } | null {
		const scroller = this.elements?.scroller

		if (scroller === undefined) return null

		const rect = scroller.getBoundingClientRect()

		return { x: clientX - rect.left, y: clientY - rect.top }
	}

	// --- Scrolling ---

	// Scrolls the least that brings a cell fully into view (frozen rows and columns are always in view).
	reveal(point: GridPoint): void {
		const sheet = this.model.getSnapshot().sheet

		this.model.grow(sheet, point.row, point.col)
		this.view = this.computeView()

		const view = this.view

		if (view === null) return

		const top = revealOffset(view.rows, point.row)
		const left = revealOffset(view.cols, point.col)

		if (top === view.rows.scroll && left === view.cols.scroll) return

		this.scroll.top = top
		this.scroll.left = left
		this.view = this.computeView()
		this.writeScroll()
		this.schedule()
	}

	// Scrolls a screen (Page Down, Alt+Page Down): as far as the active cell moved from `from` to `to`, so it keeps its
	// place on screen as in Excel, then the least more that shows it fully (at the sheet's start, past frozen panes).
	page(from: GridPoint, to: GridPoint): void {
		this.model.grow(this.model.getSnapshot().sheet, to.row, to.col)
		this.view = this.computeView()

		const view = this.view

		if (view === null) return

		const moved = (axis: GridView["rows"], start: number, end: number): number =>
			axis.scroll + axis.axis.offset(Math.max(end, axis.frozenEnd)) - axis.axis.offset(Math.max(start, axis.frozenEnd))

		this.scroll.top = moved(view.rows, from.row, to.row)
		this.scroll.left = moved(view.cols, from.col, to.col)
		this.view = this.computeView()

		const shifted = this.view

		if (shifted !== null) {
			this.scroll.top = revealOffset(shifted.rows, to.row)
			this.scroll.left = revealOffset(shifted.cols, to.col)
			this.view = this.computeView()
		}

		this.writeScroll()
		this.schedule()
	}

	// A wheel step on a scaled axis (one whose scrolled part is larger than the browser's scroll range): taken and
	// applied in the sheet's own pixels, so a step moves the rows it moves on any other sheet. False leaves it to the
	// browser (no scaled axis, or the step is along one that is not).
	wheel(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">): boolean {
		const view = this.view

		if (view === null) return false

		const scaledRows = domExtent(bodyTotal(view.rows)) < bodyTotal(view.rows)
		const scaledCols = domExtent(bodyTotal(view.cols)) < bodyTotal(view.cols)

		if (!scaledRows && !scaledCols) return false

		// Lines as a row (or column) at the default size, pages as the scrolled part's view.
		const unit = (axis: GridView["rows"]): number =>
			event.deltaMode === 1 ? axis.axis.defaultSize : event.deltaMode === 2 ? Math.max(1, axis.bodyView) : 1
		// Shift turns a vertical wheel sideways, as the browsers do.
		const sideways = event.shiftKey && event.deltaX === 0
		const dy = sideways ? 0 : event.deltaY * unit(view.rows)
		const rawX = sideways ? event.deltaY : event.deltaX
		// Mirrored, the scrollbar runs from the right: a step right brings in the columns on the left.
		const dx = rawX * unit(view.cols) * (this.mirrored() ? -1 : 1)

		if ((dy === 0 || !scaledRows) && (dx === 0 || !scaledCols)) return false

		this.scrollBy(dx, dy)

		return true
	}

	// Scrolls by pixels (dragging a selection past the edge, a wheel step on a scaled axis).
	scrollBy(dx: number, dy: number): void {
		const view = this.view

		if (view === null || (dx === 0 && dy === 0)) return

		this.scroll.top = Math.max(0, view.rows.scroll + dy)
		this.scroll.left = Math.max(0, view.cols.scroll + dx)
		this.view = this.computeView()
		this.writeScroll()
		this.schedule()
	}

	// Rows a page holds (PageUp, PageDown).
	pageRows(): number {
		const view = this.view

		return view === null ? 20 : Math.max(1, view.rows.last - view.rows.first)
	}

	// Columns a screen holds (Alt+Page Up, Alt+Page Down).
	pageCols(): number {
		const view = this.view

		return view === null ? 8 : Math.max(1, view.cols.last - view.cols.first)
	}

	// A screen position along an axis's edge, for a resize's guide: where `index` ends.
	edgePosition(axis: "rows" | "cols", index: number): number | null {
		const view = this.view

		if (view === null) return null

		const own = axis === "rows" ? view.rows : view.cols

		return screenOf(own, index) + own.axis.size(index)
	}

	// Measures text as the grid draws it (autofit).
	measurerFor(): TextMeasurer | null {
		return this.measurer
	}

	themeFont(): string {
		return this.currentTheme().font
	}
}
