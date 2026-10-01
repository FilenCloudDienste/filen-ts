import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { isToggleModifier } from "@/features/drive/lib/listbox"
import { isScrollbarPress } from "@/features/drive/lib/clickAway.logic"
import {
	clampMarqueeRect,
	marqueeAutoScrollTop,
	marqueeAutoScrollVelocity,
	marqueeContentBox,
	marqueeIndexAtPoint,
	marqueeIndices,
	marqueeRectFromPoints,
	marqueeScrollBounds,
	type MarqueeContentBox,
	type MarqueeContentRect
} from "@/features/drive/lib/marquee.logic"
import { createListenerSet } from "@/lib/listenerSet"
import { useLatestRef } from "@/lib/useLatestRef"
import { exceedsDragThreshold, listenWindowDrag } from "@/lib/windowDrag"

// Windows-Explorer edge auto-scroll: within this many px of the container's top/bottom, the listing
// scrolls while marqueeing, at up to this many px per frame (ramped by proximity).
const AUTO_SCROLL_EDGE_PX = 32
const AUTO_SCROLL_MAX_SPEED_PX = 18
const EMPTY_KEYS: ReadonlySet<string> = new Set()

// The one thing a marqueeable item has to expose: a stable identity for the additive-union set.
export interface MarqueeItem {
	data: { uuid: string }
}

// The item geometry the hit-test needs, injected rather than read from drive's gridLayout constants.
// Drive computes it from its viewMode at the call site, keeping gridLayout.ts its own source of truth.
export interface MarqueeGeometry {
	rowHeight: number
	tileWidth: number
}

// A layout whose rows are not uniform (the photos timeline's month headers) hit-tests itself. Both
// take content-space coordinates and the content box width.
export interface MarqueeHitTest {
	indices: (rect: MarqueeContentRect, contentWidth: number) => number[]
	indexAtPoint: (x: number, y: number, contentWidth: number) => number
}

// Uniform rows: a list, or a grid of equal rows.
interface MarqueeUniformLayout {
	viewMode: DriveViewMode
	columns: number
	// Replaces the rowHeightFor(viewMode) lookup this hook used to do against drive's own constants.
	geometry: MarqueeGeometry
	// Content above the first item in the scrolled layer (drive's pending transfer rows), which the
	// items start below.
	offsetTop?: number
}

type MarqueeParams<T extends MarqueeItem> = {
	items: T[]
	// Selection identity for the additive union. Defaults to the uuid; drive passes its row key, since
	// the Shared by me root lists one item once per receiver.
	keyOf?: (item: T) => string
	// The selection store this marquee drives — drive's useDriveStore, photos' usePhotosStore.
	selection: { read: () => T[]; write: (items: T[]) => void }
	scrollElement: HTMLDivElement | null
	// Moves the roving cursor to the drag-end item, mirroring how a click sets it.
	setCursor: (index: number) => void
} & (MarqueeUniformLayout | { hitTest: MarqueeHitTest })

function uuidKey(item: MarqueeItem): string {
	return item.data.uuid
}

function uniformHitTest(itemCount: number, { viewMode, columns, geometry, offsetTop = 0 }: MarqueeUniformLayout): MarqueeHitTest {
	return {
		indices: (rect, contentWidth) =>
			marqueeIndices(
				{ ...rect, top: rect.top - offsetTop, bottom: rect.bottom - offsetTop },
				itemCount,
				viewMode,
				columns,
				contentWidth,
				geometry.tileWidth,
				geometry.rowHeight
			),
		indexAtPoint: (x, y, contentWidth) =>
			marqueeIndexAtPoint(x, y - offsetTop, itemCount, viewMode, columns, contentWidth, geometry.tileWidth, geometry.rowHeight)
	}
}

// Live per-drag state. Kept entirely in a ref (not React state): it mutates on every pointermove/frame
// and must not itself drive renders — only the rendered rectangle does, via the rect store below. Keeping
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
	// only built for additive drags; empty otherwise
	presetKeys: ReadonlySet<string>
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

// The rectangle lives outside the host's state: it changes on every pointermove, and as host state it
// would re-render the whole listing per frame even when the covered set is unchanged. Only <MarqueeRect>
// subscribes.
export interface MarqueeRectStore {
	get: () => MarqueeContentRect | null
	subscribe: (listener: () => void) => () => void
}

interface WritableMarqueeRectStore extends MarqueeRectStore {
	set: (next: MarqueeContentRect | null) => void
}

function createMarqueeRectStore(): WritableMarqueeRectStore {
	const listeners = createListenerSet("marqueeRect")
	let current: MarqueeContentRect | null = null

	return {
		get: () => current,
		subscribe: listeners.subscribe,
		set: next => {
			if (next === current) {
				return
			}

			current = next
			listeners.emit()
		}
	}
}

export interface MarqueeSelection {
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
	rectStore: MarqueeRectStore
}

// Rubber-band selection over a virtualized listbox (the drive listing in list OR grid mode, and the
// photos grid). Pointer-down on blank listbox space arms it; a drag past the threshold renders a
// rectangle and continuously replaces (or, under ctrl/cmd, unions) the selection with the items it
// covers — hit-tested in item space so scrolled-away rows count. Auto-scrolls near the edges; Escape
// cancels and restores the arm-time selection.
export function useMarqueeSelection<T extends MarqueeItem>(params: MarqueeParams<T>): MarqueeSelection {
	const { items, selection, scrollElement, setCursor, keyOf = uuidKey } = params
	const hitTest = "hitTest" in params ? params.hitTest : uniformHitTest(items.length, params)
	const [rectStore] = useState(createMarqueeRectStore)
	// The store never changes identity; a plain ref lets the mount-only teardown reach it as a stable dep.
	const rectStoreRef = useRef(rectStore)
	const dragRef = useRef<MarqueeDrag<T> | null>(null)
	const rafRef = useRef(0)
	const detachRef = useRef<(() => void) | null>(null)

	// Latest render values, read by the window-level listeners so they never go stale without re-binding.
	// One object, so one effect on a hook that re-renders whenever the marqueed selection changes.
	const latestRef = useLatestRef({ items, hitTest, selection, scrollElement, setCursor })

	// The container's live content box, rebuilt per move from the current clientWidth + the drag's own
	// paddings — a container with no padding and no border reduces to the raw border-box math this hook
	// used before.
	function contentBoxFor(el: HTMLDivElement, drag: MarqueeDrag<T>): MarqueeContentBox {
		return marqueeContentBox(el.clientLeft, el.clientTop, el.clientWidth, drag.paddingLeft, drag.paddingTop, drag.paddingRight)
	}

	// Recomputes the rectangle from the fixed content-space anchor and the given viewport point, hit-tests
	// it, and applies the selection (replace, or union with the pre-drag set under ctrl/cmd).
	function computeAndApply(clientX: number, clientY: number): void {
		const el = latestRef.current.scrollElement
		const drag = dragRef.current

		if (!el || !drag) {
			return
		}

		const bounds = el.getBoundingClientRect()
		const box = contentBoxFor(el, drag)
		const contentX = clientX - bounds.left - box.insetLeft
		const contentY = clientY - bounds.top - box.insetTop + el.scrollTop
		// Bounded by the live scrollHeight, which the clamped rectangle can never exceed — so it can never
		// grow it either.
		const marqueeRect = clampMarqueeRect(
			marqueeRectFromPoints(drag.anchorX, drag.anchorY, contentX, contentY),
			marqueeScrollBounds(box, el.clientLeft, el.clientTop, el.clientWidth, el.scrollHeight)
		)
		const items = latestRef.current.items
		const indices = latestRef.current.hitTest.indices(marqueeRect, box.width)

		drag.lastHitIndex = indices.at(-1) ?? -1

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
				if (!drag.presetKeys.has(keyOf(item))) {
					next.push(item)
				}
			}
		} else {
			next = hitItems
		}

		latestRef.current.selection.write(next)
		rectStoreRef.current.set(marqueeRect)
	}

	// Moves the roving cursor to the item under the drag-end point, or the last covered item.
	function commitCursor(): void {
		const el = latestRef.current.scrollElement
		const drag = dragRef.current

		if (!el || !drag) {
			return
		}

		const bounds = el.getBoundingClientRect()
		const box = contentBoxFor(el, drag)
		const contentX = drag.lastClientX - bounds.left - box.insetLeft
		const contentY = drag.lastClientY - bounds.top - box.insetTop + el.scrollTop
		const index = latestRef.current.hitTest.indexAtPoint(contentX, contentY, box.width)

		if (index >= 0) {
			latestRef.current.setCursor(index)

			return
		}

		if (drag.lastHitIndex >= 0) {
			latestRef.current.setCursor(drag.lastHitIndex)
		}
	}

	function endDrag(): void {
		if (rafRef.current !== 0) {
			cancelAnimationFrame(rafRef.current)
			rafRef.current = 0
		}

		detachRef.current?.()
		detachRef.current = null

		dragRef.current = null
		rectStoreRef.current.set(null)
	}

	// rAF edge auto-scroll: while the pointer sits in an edge zone, advance scrollTop and re-hit-test at
	// the same viewport point (the fixed content anchor makes the rectangle stretch as content moves).
	function tickAutoScroll(): void {
		const el = latestRef.current.scrollElement
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
			const nextTop = marqueeAutoScrollTop(el.scrollTop, velocity, el.scrollHeight, el.clientHeight)

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
			if (!exceedsDragThreshold(event.clientX - drag.startClientX, event.clientY - drag.startClientY)) {
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
			latestRef.current.selection.write(drag.preset)
		}

		endDrag()
	}

	// A press that opens a context menu (macOS Ctrl+click is a primary-button press) is not a drag: the
	// pointer then travels over the open menu, and a marquee armed underneath it would select behind it.
	function onContextMenu(): void {
		if (dragRef.current && !dragRef.current.started) {
			endDrag()
		}
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

		if (isScrollbarPress(offsetX, offsetY, el)) {
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
		const additive = isToggleModifier(event)
		const drag: MarqueeDrag<T> = {
			anchorX: offsetX - box.insetLeft,
			anchorY: offsetY - box.insetTop + el.scrollTop,
			startClientX: event.clientX,
			startClientY: event.clientY,
			additive,
			preset,
			presetKeys: additive ? new Set(preset.map(keyOf)) : EMPTY_KEYS,
			started: false,
			lastClientX: event.clientX,
			lastClientY: event.clientY,
			lastHitIndex: -1,
			paddingLeft,
			paddingTop,
			paddingRight
		}

		dragRef.current = drag
		detachRef.current = listenWindowDrag({ move: onMove, up: onUp, cancel: onUp, key: onKey, menu: onContextMenu })
	}

	// Tear down any live drag on unmount (navigation away mid-drag).
	// endDrag reads only stable refs; a mount/unmount-only teardown is intended here.
	useEffect(() => {
		return () => {
			endDrag()
		}
	}, [])

	return { onPointerDown, rectStore }
}
