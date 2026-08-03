import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import {
	marqueeAutoScrollVelocity,
	marqueeContentBox,
	marqueeIndexAtPoint,
	marqueeIndices,
	marqueeRectFromPoints,
	type MarqueeContentBox,
	type MarqueeContentRect
} from "@/features/drive/lib/marquee.logic"

// A plain click (or a sub-threshold wiggle) must never arm the rectangle — otherwise a zero-size
// replace-mode marquee would clear the selection on every click. Only a drag past this starts it.
const START_THRESHOLD_PX = 4
// Windows-Explorer edge auto-scroll: within this many px of the container's top/bottom, the listing
// scrolls while marqueeing, at up to this many px per frame (ramped by proximity).
const AUTO_SCROLL_EDGE_PX = 32
const AUTO_SCROLL_MAX_SPEED_PX = 18

// The one thing a marqueeable item has to expose: a stable identity for the additive-union set.
export interface MarqueeItem {
	data: { uuid: string }
}

// The item geometry the hit-test needs, injected rather than read from drive's gridLayout constants so
// the photos grid (its own tile size + an 8px gap) can use the same machinery. Drive computes it from
// its viewMode at the call site, keeping gridLayout.ts its own source of truth.
export interface MarqueeGeometry {
	rowHeight: number
	tileWidth: number
	gap: number
}

interface MarqueeParams<T extends MarqueeItem> {
	items: T[]
	// Photos passes "grid" — it has no list mode; only the hit-test branch reads this.
	viewMode: DriveViewMode
	columns: number
	// Replaces the rowHeightFor(viewMode) lookup this hook used to do against drive's own constants.
	geometry: MarqueeGeometry
	// The selection store this marquee drives — drive's useDriveStore, photos' usePhotosStore.
	selection: { read: () => T[]; write: (items: T[]) => void }
	scrollElement: HTMLDivElement | null
	// Moves the roving cursor to the drag-end item, mirroring how a click sets it.
	setCursor: (index: number) => void
}

// Live per-drag state. Kept entirely in a ref (not React state): it mutates on every pointermove/frame
// and must not itself drive renders — only the rendered rectangle does, via `rect` state below. Keeping
// the mutable tracking in a ref is also what keeps this compiler-safe.
interface MarqueeDrag<T> {
	// content-space anchor (fixed while the listing scrolls under the pointer)
	anchorX: number
	anchorY: number
	// viewport-space press origin, for the start threshold
	startClientX: number
	startClientY: number
	// ctrl/cmd at arm time: union with the pre-drag set instead of replacing it
	additive: boolean
	preset: T[]
	presetUuids: Set<string>
	started: boolean
	lastClientX: number
	lastClientY: number
	// highest index the rectangle covered — cursor fallback when the drag ends over a gutter
	lastHitIndex: number
	// Read ONCE at pointer-down (one getComputedStyle per drag, never per pointermove — paddings do not
	// change mid-drag in any layout this app renders). The live clientWidth is still re-read on every
	// move, so a mid-drag resize re-measures exactly as before.
	paddingLeft: number
	paddingTop: number
	paddingRight: number
}

interface MarqueeHandlers {
	move: (event: PointerEvent) => void
	up: (event: PointerEvent) => void
	key: (event: KeyboardEvent) => void
}

export interface MarqueeSelection {
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
	rect: MarqueeContentRect | null
}

// Rubber-band selection over a virtualized listbox (the drive listing in list OR grid mode, and the
// photos grid). Pointer-down on blank listbox space arms it; a drag past the threshold renders a
// rectangle and continuously replaces (or, under ctrl/cmd, unions) the selection with the items it
// covers — hit-tested in item space so scrolled-away rows count. Auto-scrolls near the edges; Escape
// cancels and restores the arm-time selection.
export function useMarqueeSelection<T extends MarqueeItem>({
	items,
	viewMode,
	columns,
	geometry,
	selection,
	scrollElement,
	setCursor
}: MarqueeParams<T>): MarqueeSelection {
	const [rect, setRect] = useState<MarqueeContentRect | null>(null)
	const dragRef = useRef<MarqueeDrag<T> | null>(null)
	const rafRef = useRef(0)
	const handlersRef = useRef<MarqueeHandlers | null>(null)

	// Latest render values, read by the window-level listeners so they never go stale without re-binding.
	// Synced in a post-commit effect (writing refs during render is disallowed) — pointer events are
	// user-driven and always fire after commit, so the listeners never read a pre-commit value.
	const itemsRef = useRef(items)
	const viewModeRef = useRef(viewMode)
	const columnsRef = useRef(columns)
	const geometryRef = useRef(geometry)
	const selectionRef = useRef(selection)
	const scrollElementRef = useRef(scrollElement)
	const setCursorRef = useRef(setCursor)

	useEffect(() => {
		itemsRef.current = items
		viewModeRef.current = viewMode
		columnsRef.current = columns
		geometryRef.current = geometry
		selectionRef.current = selection
		scrollElementRef.current = scrollElement
		setCursorRef.current = setCursor
	})

	// The container's live content box, rebuilt per move from the current clientWidth + the drag's own
	// paddings — a container with no padding and no border reduces to the raw border-box math this hook
	// used before.
	function contentBoxFor(el: HTMLDivElement, drag: MarqueeDrag<T>): MarqueeContentBox {
		return marqueeContentBox(el.clientLeft, el.clientTop, el.clientWidth, drag.paddingLeft, drag.paddingTop, drag.paddingRight)
	}

	// Recomputes the rectangle from the fixed content-space anchor and the given viewport point, hit-tests
	// it, and applies the selection (replace, or union with the pre-drag set under ctrl/cmd).
	function computeAndApply(clientX: number, clientY: number): void {
		const el = scrollElementRef.current
		const drag = dragRef.current

		if (!el || !drag) {
			return
		}

		const bounds = el.getBoundingClientRect()
		const box = contentBoxFor(el, drag)
		const contentX = clientX - bounds.left - box.insetLeft
		const contentY = clientY - bounds.top - box.insetTop + el.scrollTop
		const marqueeRect = marqueeRectFromPoints(drag.anchorX, drag.anchorY, contentX, contentY)
		const items = itemsRef.current
		const geometry = geometryRef.current
		const indices = marqueeIndices(
			marqueeRect,
			items.length,
			viewModeRef.current,
			columnsRef.current,
			box.width,
			geometry.tileWidth,
			geometry.rowHeight,
			geometry.gap
		)

		drag.lastHitIndex = indices.length > 0 ? (indices[indices.length - 1] ?? -1) : -1

		const hitItems: T[] = []

		for (const index of indices) {
			const item = items[index]

			if (item) {
				hitItems.push(item)
			}
		}

		let next: T[]

		if (drag.additive) {
			next = drag.preset.slice()

			for (const item of hitItems) {
				if (!drag.presetUuids.has(item.data.uuid)) {
					next.push(item)
				}
			}
		} else {
			next = hitItems
		}

		selectionRef.current.write(next)
		setRect(marqueeRect)
	}

	// Moves the roving cursor to the item under the drag-end point, or the last covered item.
	function commitCursor(): void {
		const el = scrollElementRef.current
		const drag = dragRef.current

		if (!el || !drag) {
			return
		}

		const bounds = el.getBoundingClientRect()
		const box = contentBoxFor(el, drag)
		const contentX = drag.lastClientX - bounds.left - box.insetLeft
		const contentY = drag.lastClientY - bounds.top - box.insetTop + el.scrollTop
		const geometry = geometryRef.current
		const index = marqueeIndexAtPoint(
			contentX,
			contentY,
			itemsRef.current.length,
			viewModeRef.current,
			columnsRef.current,
			box.width,
			geometry.tileWidth,
			geometry.rowHeight,
			geometry.gap
		)

		if (index >= 0) {
			setCursorRef.current(index)

			return
		}

		if (drag.lastHitIndex >= 0) {
			setCursorRef.current(drag.lastHitIndex)
		}
	}

	function endDrag(): void {
		if (rafRef.current !== 0) {
			cancelAnimationFrame(rafRef.current)
			rafRef.current = 0
		}

		const handlers = handlersRef.current

		if (handlers) {
			window.removeEventListener("pointermove", handlers.move)
			window.removeEventListener("pointerup", handlers.up)
			window.removeEventListener("pointercancel", handlers.up)
			window.removeEventListener("keydown", handlers.key, true)
			handlersRef.current = null
		}

		dragRef.current = null
		setRect(null)
	}

	// rAF edge auto-scroll: while the pointer sits in an edge zone, advance scrollTop and re-hit-test at
	// the same viewport point (the fixed content anchor makes the rectangle stretch as content moves).
	function tickAutoScroll(): void {
		const el = scrollElementRef.current
		const drag = dragRef.current

		if (!el || !drag?.started) {
			rafRef.current = 0

			return
		}

		const bounds = el.getBoundingClientRect()
		const velocity = marqueeAutoScrollVelocity(
			drag.lastClientY,
			bounds.top,
			bounds.height,
			AUTO_SCROLL_EDGE_PX,
			AUTO_SCROLL_MAX_SPEED_PX
		)

		if (velocity !== 0) {
			const maxScroll = el.scrollHeight - el.clientHeight
			const nextTop = Math.min(maxScroll, Math.max(0, el.scrollTop + velocity))

			if (nextTop !== el.scrollTop) {
				el.scrollTop = nextTop
				computeAndApply(drag.lastClientX, drag.lastClientY)
			}
		}

		rafRef.current = requestAnimationFrame(tickAutoScroll)
	}

	function onMove(event: PointerEvent): void {
		const drag = dragRef.current

		if (!drag) {
			return
		}

		drag.lastClientX = event.clientX
		drag.lastClientY = event.clientY

		if (!drag.started) {
			const dx = event.clientX - drag.startClientX
			const dy = event.clientY - drag.startClientY

			if (Math.hypot(dx, dy) < START_THRESHOLD_PX) {
				return
			}

			drag.started = true

			if (rafRef.current === 0) {
				rafRef.current = requestAnimationFrame(tickAutoScroll)
			}
		}

		computeAndApply(event.clientX, event.clientY)
	}

	function onUp(event: PointerEvent): void {
		const drag = dragRef.current

		if (!drag) {
			return
		}

		if (drag.started) {
			drag.lastClientX = event.clientX
			drag.lastClientY = event.clientY
			computeAndApply(event.clientX, event.clientY)
			commitCursor()
		}

		endDrag()
	}

	// Capture-phase so this wins over the document-level drive.clearSelection hotkey: cancelling the
	// marquee must restore the arm-time selection, never clear it.
	function onKey(event: KeyboardEvent): void {
		if (event.key !== "Escape") {
			return
		}

		const drag = dragRef.current

		if (!drag) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (drag.started) {
			selectionRef.current.write(drag.preset)
		}

		endDrag()
	}

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		// Mouse only — touch/pen are ignored (they scroll/long-press). Primary button, no modifier
		// required to start (ctrl/cmd only flips it additive).
		if (event.pointerType !== "mouse" || event.button !== 0) {
			return
		}

		const target = event.target instanceof HTMLElement ? event.target : null

		// Starting on a row/tile (or its menu chrome) leaves click-selection untouched.
		if (target?.closest('[role="option"]')) {
			return
		}

		const el = event.currentTarget
		const bounds = el.getBoundingClientRect()
		const offsetX = event.clientX - bounds.left
		const offsetY = event.clientY - bounds.top

		// The scrollbar gutter lives outside the client box — never arm a drag from it. Compared against
		// the PADDING box (offset by clientLeft/clientTop), so a bordered container is exact too.
		if (offsetX - el.clientLeft >= el.clientWidth || offsetY - el.clientTop >= el.clientHeight) {
			return
		}

		if (dragRef.current) {
			endDrag()
		}

		const style = getComputedStyle(el)
		const paddingLeft = parseFloat(style.paddingLeft) || 0
		const paddingTop = parseFloat(style.paddingTop) || 0
		const paddingRight = parseFloat(style.paddingRight) || 0
		const box = marqueeContentBox(el.clientLeft, el.clientTop, el.clientWidth, paddingLeft, paddingTop, paddingRight)
		const preset = selection.read()
		const drag: MarqueeDrag<T> = {
			anchorX: offsetX - box.insetLeft,
			anchorY: offsetY - box.insetTop + el.scrollTop,
			startClientX: event.clientX,
			startClientY: event.clientY,
			additive: event.metaKey || event.ctrlKey,
			preset,
			presetUuids: new Set(preset.map(item => item.data.uuid)),
			started: false,
			lastClientX: event.clientX,
			lastClientY: event.clientY,
			lastHitIndex: -1,
			paddingLeft,
			paddingTop,
			paddingRight
		}
		const handlers: MarqueeHandlers = { move: onMove, up: onUp, key: onKey }

		dragRef.current = drag
		handlersRef.current = handlers
		window.addEventListener("pointermove", handlers.move)
		window.addEventListener("pointerup", handlers.up)
		window.addEventListener("pointercancel", handlers.up)
		window.addEventListener("keydown", handlers.key, true)
	}

	// Tear down any live drag on unmount (navigation away mid-drag).
	// endDrag reads only stable refs; a mount/unmount-only teardown is intended here.
	useEffect(() => {
		return () => {
			endDrag()
		}
	}, [])

	return { onPointerDown, rect }
}
