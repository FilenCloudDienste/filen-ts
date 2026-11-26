import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { isToggleModifier } from "@/features/drive/lib/listbox"
import { isScrollbarPress } from "@/features/drive/lib/clickAway.logic"
import {
	AUTO_SCROLL_EDGE_PX,
	AUTO_SCROLL_MAX_SPEED_PX,
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

interface MarqueeCommon {
	scrollElement: HTMLDivElement | null
	// Moves the roving cursor to the drag-end item, mirroring how a click sets it.
	setCursor: (index: number) => void
	// A press on an item arms the marquee too, except on its controls (a button, a link, an input, or what
	// carries MARQUEE_SKIP_PROPS). For a list whose items are no drag sources (the archive browser);
	// elsewhere a press on an item is left to click-selection and drag-and-drop.
	startsOnItems?: boolean
}

type MarqueeLayout = MarqueeUniformLayout | { hitTest: MarqueeHitTest }

// The marquee over an item array, the selection being the items themselves.
export type MarqueeParams<T extends MarqueeItem> = {
	items: T[]
	// Selection identity for the additive union. Defaults to the uuid; drive passes its row key, since
	// the Shared by me root lists one item once per receiver.
	keyOf?: (item: T) => string
	// The selection store this marquee drives — drive's useDriveStore, photos' usePhotosStore.
	selection: { read: () => T[]; write: (items: T[]) => void }
} & MarqueeCommon &
	MarqueeLayout

// A selection the host keeps in its own shape, addressed by item index: a list too large to hand over as
// items, or whose selection is no set of them (the archive browser's rules).
export interface MarqueeIndexSelection<S> {
	read: () => S
	write: (next: S) => void
	// The selection a drag covering `indices` (ascending) makes: those alone, or added to `preset`, the
	// selection at the press, when the drag is additive (null otherwise).
	cover: (indices: readonly number[], preset: S | null) => S
}

export type MarqueeIndexParams<S> = {
	itemCount: number
	selection: MarqueeIndexSelection<S>
} & MarqueeCommon &
	MarqueeLayout

// Spread onto an item's own control that a press must not start a marquee from (see startsOnItems).
export const MARQUEE_SKIP_PROPS = { "data-marquee-skip": "" }

const ITEM_CONTROL_SELECTOR = "button, a, input, [data-marquee-skip]"

// One drag's hold on the selection, taken at the press.
interface MarqueeArm {
	// Selects what the rectangle covers now.
	cover: (indices: readonly number[]) => void
	// Puts back the selection the drag started from (Escape).
	restore: () => void
}

function stopClick(event: MouseEvent): void {
	event.stopPropagation()
}

// Keeps the click a pointerup is about to produce from reaching the page. The browser dispatches it in
// the same task as the pointerup, so a listener dropped on the next task catches that click alone.
function swallowNextClick(): void {
	window.addEventListener("click", stopClick, { capture: true, once: true })
	setTimeout(() => {
		window.removeEventListener("click", stopClick, true)
	}, 0)
}

function sameIndices(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) {
		return false
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false
		}
	}

	return true
}

function uuidKey(item: MarqueeItem): string {
	return item.data.uuid
}

// The items at `indices`, alone, or after the additive preset's minus those it already holds.
function coverItems<T>(
	items: readonly T[],
	indices: readonly number[],
	preset: T[] | null,
	presetKeys: ReadonlySet<string>,
	keyOf: (item: T) => string
): T[] {
	const next = preset === null ? [] : preset.slice()

	for (const index of indices) {
		const item = items[index]

		if (item !== undefined && (preset === null || !presetKeys.has(keyOf(item)))) {
			next.push(item)
		}
	}

	return next
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
interface MarqueeDrag {
	// content-space anchor (fixed while the listing scrolls under the pointer)
	anchorX: number
	anchorY: number
	// viewport-space press origin, for the start threshold
	startClientX: number
	startClientY: number
	// the selection at the press, and how the drag replaces it (or, ctrl/cmd held then, adds to it)
	arm: MarqueeArm
	started: boolean
	lastClientX: number
	lastClientY: number
	// highest index the rectangle covered — cursor fallback when the drag ends over a gutter
	lastHitIndex: number
	// The indices the selection was last set from (null before the first) and the render's params they were
	// read against, so a rectangle still covering the same items of the same listing writes nothing.
	covered: readonly number[] | null
	coveredParams: unknown
	// The pointer moved since the rectangle was last applied: the frame loop applies it then.
	moved: boolean
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
//
// The selection is an item array (`items`), or the host's own addressed by index (`itemCount`).
export function useMarqueeSelection<T extends MarqueeItem>(params: MarqueeParams<T>): MarqueeSelection
export function useMarqueeSelection<S>(params: MarqueeIndexParams<S>): MarqueeSelection
export function useMarqueeSelection<T extends MarqueeItem, S>(params: MarqueeParams<T> | MarqueeIndexParams<S>): MarqueeSelection {
	const { scrollElement, setCursor } = params
	const itemCount = "items" in params ? params.items.length : params.itemCount
	const hitTest = "hitTest" in params ? params.hitTest : uniformHitTest(itemCount, params)
	const [rectStore] = useState(createMarqueeRectStore)
	// The store never changes identity; a plain ref lets the mount-only teardown reach it as a stable dep.
	const rectStoreRef = useRef(rectStore)
	const dragRef = useRef<MarqueeDrag | null>(null)
	const rafRef = useRef(0)
	const detachRef = useRef<(() => void) | null>(null)

	// Latest render values, read by the window-level listeners so they never go stale without re-binding.
	// One object, so one effect on a hook that re-renders whenever the marqueed selection changes.
	const latestRef = useLatestRef({ params, hitTest, scrollElement, setCursor })

	// The container's live content box, rebuilt per move from the current clientWidth + the drag's own
	// paddings — a container with no padding and no border reduces to the raw border-box math this hook
	// used before.
	function contentBoxFor(el: HTMLDivElement, drag: MarqueeDrag): MarqueeContentBox {
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
		const indices = latestRef.current.hitTest.indices(marqueeRect, box.width)

		drag.lastHitIndex = indices.at(-1) ?? -1
		drag.moved = false

		const { params: current } = latestRef.current

		if (drag.covered === null || drag.coveredParams !== current || !sameIndices(drag.covered, indices)) {
			drag.covered = indices
			drag.coveredParams = current
			drag.arm.cover(indices)
		}

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

	// The drag's frame loop: applies the pointer's latest position once per frame (Firefox delivers pointermove
	// at the mouse's own rate, up to 1000 Hz, where Chromium aligns it to frames), and while the pointer sits in
	// an edge zone advances scrollTop and re-hit-tests at the same viewport point (the fixed content anchor makes
	// the rectangle stretch as content moves).
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
				drag.moved = true
			}
		}

		if (drag.moved) {
			computeAndApply(drag.lastClientX, drag.lastClientY)
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

		drag.moved = true
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

			// Where a press on an item arms the marquee, the click its release ends in (on that item, or
			// on the list) is the drag's: it must not select or deselect again.
			if (event.type === "pointerup" && latestRef.current.params.startsOnItems === true) {
				swallowNextClick()
			}
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
			drag.arm.restore()
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

	// Snapshots the selection at the press. Covering reads the latest render's items and selection, so a
	// listing that changes mid-drag is hit-tested as it is now.
	function armSelection(additive: boolean): MarqueeArm {
		if ("items" in params) {
			const preset = params.selection.read()
			const keyOf = params.keyOf ?? uuidKey
			const presetKeys = additive ? new Set(preset.map(keyOf)) : EMPTY_KEYS

			return {
				cover: indices => {
					const latest = latestRef.current.params

					if ("items" in latest) {
						latest.selection.write(coverItems(latest.items, indices, additive ? preset : null, presetKeys, keyOf))
					}
				},
				restore: () => {
					const latest = latestRef.current.params

					if ("items" in latest) {
						latest.selection.write(preset)
					}
				}
			}
		}

		const preset = params.selection.read()

		return {
			cover: indices => {
				const latest = latestRef.current.params

				if (!("items" in latest)) {
					latest.selection.write(latest.selection.cover(indices, additive ? preset : null))
				}
			},
			restore: () => {
				const latest = latestRef.current.params

				if (!("items" in latest)) {
					latest.selection.write(preset)
				}
			}
		}
	}

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		// Mouse only — touch/pen are ignored (they scroll/long-press). Primary button, no modifier
		// required to start (ctrl/cmd only flips it additive).
		if (event.pointerType !== "mouse" || event.button !== 0) {
			return
		}

		// Any element: an icon's SVG inside a row is a press on the row.
		const target = event.target instanceof Element ? event.target : null
		const el = event.currentTarget

		// A press in a menu portalled out of the list still bubbles to it through the React tree.
		if (target === null || !el.contains(target)) {
			return
		}

		// Starting on a row/tile (or its menu chrome) leaves click-selection untouched, unless the list
		// marquees from its items too (never from their controls).
		if (target.closest('[role="option"]') && (params.startsOnItems !== true || target.closest(ITEM_CONTROL_SELECTOR) !== null)) {
			return
		}

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
		const drag: MarqueeDrag = {
			anchorX: offsetX - box.insetLeft,
			anchorY: offsetY - box.insetTop + el.scrollTop,
			startClientX: event.clientX,
			startClientY: event.clientY,
			arm: armSelection(isToggleModifier(event)),
			started: false,
			lastClientX: event.clientX,
			lastClientY: event.clientY,
			lastHitIndex: -1,
			covered: null,
			coveredParams: null,
			moved: false,
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
