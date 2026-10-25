import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	type RefObject
} from "react"
import type { SheetId } from "../../../core/sheet/protocol"
import type { DrawingAnchor } from "../../../core/xlsx/drawings/anchor"
import type { SheetDrawingObject, SheetDrawings } from "../../../core/xlsx/drawings/feature"
import type { DrawingRender } from "../../../core/xlsx/drawings/render"
import type { DocxMedia } from "../../../dom/docx/protocol"
import { rasterOpaque, rasterSize } from "../../../core/docx/objects/images"
import { DocxMediaCache } from "../../docx/media"
import { drawingImages, imageMime, inlineImageUrls, paintDrawing } from "../../docx/paint/drawing"
import type { SheetGridModel } from "../model"
import type { SheetGridHandle } from "../SheetGrid"
import {
	canvasPicture,
	drawPicture,
	regionContains,
	regionIn,
	releaseCanvas,
	sameRegion,
	sourceOf,
	type PictureRegion
} from "./canvasPicture"
import { FittedPictures, fittedSize, wantsFit } from "./fitted"
import { anchorBox, anchorOf, draggedBox, nearView, placeOnScreen, type Handle, type SheetBox } from "./geometry"

// A sheet's drawing objects over the grid (SheetGrid's children): each drawn as SVG from its display list (pictures'
// media read once and shared), or by `renderGraphic` (charts), placed on its anchor and re-placed imperatively on
// every frame the grid draws. An object is drawn once it comes on screen or near it (the others keep an empty box), and
// stays drawn while the sheet shows: an SVG <image> decoded again would only add to what Chromium keeps of it for the
// document's life. A plain raster picture is drawn on a canvas instead (canvasPicture.ts), decoded at its box's size
// and its pixels released while it is out of view. A selected object shows its frame and eight handles: dragged, it moves; a
// handle resizes it (a corner keeps the picture's proportions; Shift does the other); arrows nudge it; Delete removes
// it. The keys follow Excel's for floating shapes ("Keyboard shortcuts in Excel"): Tab and Shift+Tab cycle the
// objects (objectInView picks the first, Ctrl+Alt+5), Escape gives the keys back to the grid, Enter or F2 opens what a
// double-click does (a chart's editor), Shift+F10 or the menu key opens its menu; Tab past the last object moves on
// to what follows the grid (a task pane: the chart editor), Shift+Tab before the first returns to the cells. F6 is
// the view's, which cycles its panes.

export interface SheetObjectSource {
	// since: the stamp a drawing holding charts last answered with (DrawingRender's live).
	render(sheet: SheetId, key: number, stamp: string, since?: string): Promise<DrawingRender | null>
	media(partName: string): Promise<DocxMedia | null>
}

export interface SheetObjectsProps {
	readonly grid: SheetGridModel
	readonly handle: RefObject<SheetGridHandle | null>
	readonly sheet: SheetId
	readonly drawings: SheetDrawings | undefined
	readonly source: SheetObjectSource
	// The selected object's key, or null.
	readonly selected: number | null
	readonly canEdit: boolean
	readonly onSelect: (object: SheetDrawingObject | null) => void
	// Resolves false when the move was refused: what the drag showed goes back.
	readonly onMove: (object: SheetDrawingObject, anchor: DrawingAnchor) => Promise<boolean>
	readonly onDelete: (object: SheetDrawingObject) => void
	// A double-click, or Enter or F2 on the selected object (a chart's editor).
	readonly onActivate?: (object: SheetDrawingObject) => void
	// What draws objects the display list does not (chart frames), at their size in px and the zoom (the factor the
	// sheet's own sizes are multiplied by: a chart lays out at 100 % and scales).
	readonly renderGraphic?: (object: SheetDrawingObject, width: number, height: number, scale: number) => ReactNode | undefined
	// The accessible name of an object (its alternative text, else a description of it).
	readonly label: (object: SheetDrawingObject) => string
}

const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

// A press that moves less than this is a click (it selects, it does not move).
const DRAG_SLOP = 3

// Objects within this many views' sizes of the view are drawn (DRAW_MARGIN). A picture on a canvas holds pixels for
// the part of its box within KEEP_MARGIN, drawn again once the part within CANVAS_MARGIN is not all held, and gives them
// back past KEEP_MARGIN: a canvas holds every pixel it has, where the platform rasters an <image> only where it shows.
const DRAW_MARGIN = 0.5
const CANVAS_MARGIN = 0.25
const KEEP_MARGIN = 0.5

// The device pixels the canvases hold in all, in views of the grid's (what shows comes first).
const CANVAS_VIEWS = 4

// How much larger (in device pixels) the view must grow than when pictures went to SVG before they try canvases again:
// enough that a picture at the budget's edge does not flip back and forth as the view changes a little.
const SVG_RETRY_GROWTH = 1.25

type CanvasKind = "opaque" | "canvas" | "none"

const OBJECT_MEDIA_LIMITS = { maxBytes: 96 * 1024 * 1024, maxEntries: Number.POSITIVE_INFINITY }

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'

interface ObjectSize {
	readonly width: number
	readonly height: number
	readonly scale: number
}

interface Drag {
	readonly pointerId: number
	readonly object: SheetDrawingObject
	readonly handle: Handle | null
	readonly startX: number
	readonly startY: number
	readonly start: SheetBox
	readonly keepRatio: boolean
	moved: boolean
}

let painted = 0

// A prefix of ids unique to each painted drawing on the page.
function paintId(): string {
	painted++

	return `fos${String(painted)}-`
}

export function SheetObjects(props: SheetObjectsProps) {
	const { grid, handle, sheet, drawings, selected } = props
	// The session's version: a group holding charts draws again when it moves (its charts follow the cells).
	const version = useSyncExternalStore(grid.subscribe, () => grid.getSnapshot().state.version)
	const elements = useRef(new Map<number, HTMLDivElement>())
	const drag = useRef<Drag | null>(null)
	// The box a drag shows until the session's answer lands, by key.
	const draft = useRef<{ key: number; box: SheetBox } | null>(null)
	const [sizes, setSizes] = useState<ReadonlyMap<string, ObjectSize>>(new Map())
	// The objects drawn (on screen or near it), by key.
	const [near, setNear] = useState<ReadonlySet<number>>(new Set())
	// What of each object near the view a canvas would hold (the canvas margin's part of its box, kept while that stays
	// inside it and the object within the keep margin): pictures on a canvas hold pixels only for that, by key.
	const [regions, setRegions] = useState<ReadonlyMap<string, PictureRegion>>(new Map())
	const latest = useRef(props)
	// Pictures' object URLs, shared by every object of the view (`source` stays the same for a session).
	const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)
	// Bounded by bytes only: a picture scrolled out and back keeps its URL (and the platform its decode) for as long
	// as the encoded pictures fit, however many there are.
	const [media] = useState(() => {
		const source = props.source

		return new DocxMediaCache({ media: partName => source.media(partName) }, OBJECT_MEDIA_LIMITS)
	})
	const [fitted] = useState(() => new FittedPictures())
	// Device pixels per CSS pixel, followed as it changes (zoom, another screen): canvases are drawn again at it.
	const [ratio, setRatio] = useState(deviceRatio)

	useEffect(() => {
		if (typeof matchMedia !== "function") return undefined

		let query: MediaQueryList | null = null
		// A query for the ratio there is now, asked again at each change; a resize (the browser's zoom resizes the view
		// in CSS pixels) is looked at too, where a platform tells only that.
		const follow = (): void => {
			const current = deviceRatio()

			query?.removeEventListener("change", follow)
			query = matchMedia(`(resolution: ${String(current)}dppx)`)
			query.addEventListener("change", follow)
			setRatio(current)
		}
		const resized = (): void => {
			setRatio(deviceRatio())
		}

		follow()
		window.addEventListener("resize", resized)

		return () => {
			query?.removeEventListener("change", follow)
			window.removeEventListener("resize", resized)
		}
	}, [])
	const objects = drawings?.objects.filter(object => !object.hidden) ?? []
	// What place() last drew and last found close (read there without a render).
	const shownRef = useRef<ReadonlySet<number>>(near)
	const regionsRef = useRef<ReadonlyMap<string, PictureRegion>>(regions)
	// What each drawn object is: a picture on a canvas, opaque or not, or anything else (ObjectDrawing tells), by key.
	const kindRef = useRef(new Map<string, CanvasKind>())
	// Pictures past the canvases' budget, drawn as SVG from then on (by key).
	const svgOnlyRef = useRef(new Set<string>())
	// The stamps place() last saw, by key.
	const stampsRef = useRef<readonly string[]>([])
	// The view's device pixels when a picture last went to SVG: a view grown well past them lets them all try again.
	const svgSince = useRef(0)
	const [svgOnly, setSvgOnly] = useState<ReadonlySet<string>>(() => new Set())
	// A report of what a drawing is lands in a frame of its own (one for any number of reports).
	const placeSoon = useRef<number | null>(null)

	useEffect(() => {
		latest.current = props
	})

	useEffect(() => () => media.dispose(), [media])
	useEffect(() => () => fitted.dispose(), [fitted])
	useEffect(
		() => () => {
			if (placeSoon.current !== null) cancelAnimationFrame(placeSoon.current)

			// Or no placing would be asked for again (StrictMode's rehearsed unmount keeps the component).
			placeSoon.current = null
		},
		[]
	)

	// A new listing (the answer to a move) replaces what a drag showed.
	useEffect(() => {
		draft.current = null
	}, [drawings])

	useEffect(() => {
		const gridHandle = handle.current

		if (gridHandle === null) return undefined

		const place = (): void => {
			const view = gridHandle.renderer.currentView()
			const axes = grid.axes(sheet)
			const layout = grid.layout(sheet)
			const list = latest.current.drawings?.objects ?? []
			const nextSizes = new Map<string, ObjectSize>()
			const nextNear = new Set<number>()
			const nextRegions = new Map<string, PictureRegion>()
			const boxes = new Map<number, SheetBox>()
			let marksChanged = false
			const stamps = list.map(object => object.stamp)

			// An object edited in place (moved, resized: as many objects, a new stamp at a key) keeps what its drawing said
			// it is until it says so again; after an insert or a delete keys shift, and nothing carries over.
			if (stamps.length === stampsRef.current.length) {
				stamps.forEach((stamp, k) => {
					const before = stampsRef.current[k]

					if (before === undefined || before === stamp || kindRef.current.has(stamp)) return

					const kind = kindRef.current.get(before)

					if (kind !== undefined) kindRef.current.set(stamp, kind)
					if (svgOnlyRef.current.has(before)) {
						svgOnlyRef.current.add(stamp)
						marksChanged = true
					}
				})
			}

			if (stamps.length !== stampsRef.current.length || stamps.some((stamp, k) => stamp !== stampsRef.current[k])) {
				// What objects gone were is forgotten.
				const listed = new Set(stamps)

				for (const stamp of kindRef.current.keys()) if (!listed.has(stamp)) kindRef.current.delete(stamp)
				for (const stamp of svgOnlyRef.current) if (!listed.has(stamp)) svgOnlyRef.current.delete(stamp)
			}

			stampsRef.current = stamps

			for (const object of list) {
				const element = elements.current.get(object.key)
				const pane = element?.parentElement

				if (element === undefined || pane === null || pane === undefined) continue

				if (view === null || axes === null || layout === null) {
					pane.style.visibility = "hidden"
					continue
				}

				const box = draft.current?.key === object.key ? draft.current.box : anchorBox(object.anchor, axes)
				const at = placeOnScreen(view, box)
				// Laid out, then mirrored for a right-to-left sheet (the drawing itself is not).
				const mirrored = layout.rightToLeft
				const x = mirrored ? view.width - at.box.x - at.box.width : at.box.x
				const clipX = mirrored ? view.width - at.clip.x - at.clip.width : at.clip.x
				const width = Math.max(0, at.box.width)
				const height = Math.max(0, at.box.height)

				// The pane clips the object (its frame and handles too) below the headers and beside frozen panes.
				pane.style.visibility = "visible"
				pane.style.transform = `translate(${String(clipX)}px, ${String(at.clip.y)}px)`
				pane.style.width = `${String(at.clip.width)}px`
				pane.style.height = `${String(at.clip.height)}px`
				element.style.transform = `translate(${String(x - clipX)}px, ${String(at.box.y - at.clip.y)}px)`
				// A line has no height (or width): it still takes a pixel, so it draws and can be pressed.
				element.style.width = `${String(Math.max(1, width))}px`
				element.style.height = `${String(Math.max(1, height))}px`
				nextSizes.set(object.stamp, { width: Math.round(width), height: Math.round(height), scale: axes.scale })

				boxes.set(object.key, { x, y: at.box.y, width, height })

				const needed = regionIn(x, at.box.y, width, height, view, CANVAS_MARGIN)
				const held = regionsRef.current.get(object.stamp)

				if (needed !== null) {
					const kept = regionIn(x, at.box.y, width, height, view, KEEP_MARGIN) ?? needed

					nextRegions.set(object.stamp, held !== undefined && regionContains(held, needed) ? held : kept)
				} else if (held !== undefined && regionIn(x, at.box.y, width, height, view, KEEP_MARGIN) !== null) {
					nextRegions.set(object.stamp, held)
				} else if (svgOnlyRef.current.delete(object.stamp)) {
					// Out of view: it may come back on a canvas.
					marksChanged = true
				}
				// Drawn once near, kept drawn.
				if (nearView(view, at.box, DRAW_MARGIN) || shownRef.current.has(object.key)) nextNear.add(object.key)
			}

			// The canvases share a budget of device pixels, from the topmost picture down: first what each shows on screen
			// (a picture larger than the view, or whose shown part no longer fits, is drawn as SVG from then on), then the margins around it while the
			// budget lasts (past it, a margin holds no pixels: nothing shows there). A part an opaque picture above covers
			// whole shows nothing and holds no pixels.
			if (view !== null) {
				const scale = ratio * ratio
				const budget = CANVAS_VIEWS * view.width * view.height * scale
				const area = (part: PictureRegion): number => part.width * part.height * scale
				const covers: SheetBox[] = []
				const shownParts = new Map<string, PictureRegion>()
				const viewPixels = view.width * view.height * scale
				let used = 0

				// The view grew well past what it was when pictures went to SVG (a larger window, a zoom out, the side
				// panel closed): they may fit on canvases again.
				if (svgOnlyRef.current.size > 0 && viewPixels > svgSince.current * SVG_RETRY_GROWTH) {
					svgOnlyRef.current.clear()
					marksChanged = true
				}

				for (let k = list.length - 1; k >= 0; k--) {
					const object = list[k]

					if (object === undefined) continue

					const id = object.stamp
					const box = boxes.get(object.key)
					const kind = kindRef.current.get(id)
					const wanted = nextRegions.get(id)

					if (box === undefined || wanted === undefined) continue
					if (kind === undefined || kind === "none" || svgOnlyRef.current.has(id)) {
						nextRegions.delete(id)
						continue
					}

					const rect = (part: PictureRegion): SheetBox => ({
						x: box.x + part.x,
						y: box.y + part.y,
						width: part.width,
						height: part.height
					})
					const shown = regionIn(box.x, box.y, box.width, box.height, view, 0)
					const hidden = (part: PictureRegion): boolean => {
						const placed = rect(part)

						return covers.some(cover => covering(cover, placed))
					}

					if (shown === null || hidden(shown)) {
						// Nothing of it shows: a margin's pixels come later, if the budget lasts and nothing covers them.
						if (hidden(wanted)) nextRegions.delete(id)

						continue
					}

					// A picture larger than the view, or whose shown part no longer fits: SVG, where the platform rasters only
					// the part on screen.
					if (box.width * box.height * scale > viewPixels || used + area(shown) > budget) {
						nextRegions.delete(id)
						svgOnlyRef.current.add(id)
						svgSince.current = viewPixels
						marksChanged = true
						continue
					}

					used += area(shown)
					shownParts.set(id, shown)

					if (kind === "opaque") covers.push(rect(shown))
				}

				for (let k = list.length - 1; k >= 0; k--) {
					const id = list[k]?.stamp ?? ""
					const wanted = nextRegions.get(id)

					if (wanted === undefined) continue

					const shown = shownParts.get(id)
					const more = area(wanted) - (shown === undefined ? 0 : area(shown))

					if (used + more <= budget) used += more
					else if (shown === undefined) nextRegions.delete(id)
					else nextRegions.set(id, shown)
				}
			}

			if (marksChanged) setSvgOnly(new Set(svgOnlyRef.current))

			setSizes(previous => (sameSizes(previous, nextSizes) ? previous : nextSizes))

			if (view !== null && axes !== null && layout !== null && !sameKeys(shownRef.current, nextNear)) {
				shownRef.current = nextNear
				setNear(nextNear)
			}

			if (view !== null && axes !== null && layout !== null && !sameRegions(regionsRef.current, nextRegions)) {
				regionsRef.current = nextRegions
				setRegions(nextRegions)
			}
		}

		place()

		return gridHandle.onFrame(place)
	}, [grid, handle, sheet, drawings, ratio])

	// A newly selected object takes the keys (once its element is there: an inserted one comes with the next listing),
	// unless the keys are somewhere other than the sheet, such as a panel beside it; a new listing alone moves nothing.
	const focusPending = useRef<number | null>(null)

	useEffect(() => {
		focusPending.current = selected
	}, [selected])

	useEffect(() => {
		const pending = focusPending.current
		const element = pending === null ? undefined : elements.current.get(pending)

		if (element === undefined) return

		focusPending.current = null

		const active = element.ownerDocument.activeElement
		const root = element.closest(".fo-sheet")

		if (active === null || active === element.ownerDocument.body || root?.contains(active) === true)
			element.focus({ preventScroll: true })
	}, [selected, drawings])

	const repaint = (): void => {
		grid.repaint()
	}

	const begin = (event: PointerEvent<HTMLElement>, object: SheetDrawingObject, part: Handle | null): void => {
		if (event.button !== 0 && event.pointerType === "mouse") {
			// A secondary press selects it for the menu that opens.
			props.onSelect(object)

			return
		}

		event.stopPropagation()
		props.onSelect(object)

		const axes = grid.axes(sheet)

		if (!props.canEdit || axes === null || (part === null ? object.noMove : object.noResize)) return

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		drag.current = {
			pointerId: event.pointerId,
			object,
			handle: part,
			startX: event.clientX,
			startY: event.clientY,
			start: anchorBox(object.anchor, axes),
			keepRatio: object.kind === "picture",
			moved: false
		}
	}

	const follow = (event: PointerEvent<HTMLElement>): void => {
		const current = drag.current

		if (current === null || current.pointerId !== event.pointerId) return

		const mirrored = grid.layout(sheet)?.rightToLeft === true
		const dx = (event.clientX - current.startX) * (mirrored ? -1 : 1)
		const dy = event.clientY - current.startY

		if (!current.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return

		current.moved = true
		draft.current = {
			key: current.object.key,
			box: draggedBox(current.start, current.handle, dx, dy, current.keepRatio !== event.shiftKey)
		}
		repaint()
	}

	const end = (event: PointerEvent<HTMLElement>, commit: boolean): void => {
		const current = drag.current

		if (current === null || current.pointerId !== event.pointerId) return

		drag.current = null

		const box = draft.current?.key === current.object.key ? draft.current.box : null
		const axes = grid.axes(sheet)

		if (!commit || !current.moved || box === null || axes === null) {
			draft.current = null
			repaint()

			return
		}

		const shown = draft.current

		void props.onMove(current.object, anchorOf(current.object.anchor, box, axes, { rows: 1_048_576, cols: 16_384 })).then(moved => {
			const clear = (): void => {
				if (draft.current !== shown) return

				draft.current = null
				repaint()
			}

			// Refused: the object goes back where it is. Kept: the new listing replaces the draft, or, when the listing did
			// not change, the next frame does.
			if (!moved) clear()
			else requestAnimationFrame(clear)
		})
	}

	const key = (event: KeyboardEvent<HTMLElement>, object: SheetDrawingObject): void => {
		const axes = grid.axes(sheet)
		const step = event.altKey ? 1 : 10
		const moves: Readonly<Record<string, readonly [number, number]>> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step]
		}
		const move = moves[event.key]

		if ((event.key === "Enter" || event.key === "F2") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			props.onActivate?.(object)
		} else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
			// The object's menu (the grid's, which lists what acts on the selected object), where the object stands.
			const box = event.currentTarget.getBoundingClientRect()

			event.currentTarget.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: box.left + Math.min(box.width / 2, 16),
					clientY: box.top + Math.min(box.height / 2, 16)
				})
			)
		} else if (event.key === "Delete" || event.key === "Backspace") {
			if (props.canEdit) props.onDelete(object)
		} else if (event.key === "Escape") {
			props.onSelect(null)
			handle.current?.focus()
		} else if (move !== undefined) {
			if (props.canEdit && !object.noMove && axes !== null) {
				const box = anchorBox(object.anchor, axes)
				const dx = grid.layout(sheet)?.rightToLeft === true ? -move[0] : move[0]

				props.onMove(
					object,
					anchorOf(object.anchor, { ...box, x: box.x + dx, y: box.y + move[1] }, axes, { rows: 1_048_576, cols: 16_384 })
				)
			}
		} else if (event.key === "Tab") {
			// Tab walks the objects in z-order, as in Excel; past the last it moves on, before the first back to the cells.
			const at = objects.findIndex(candidate => candidate.key === object.key)
			const next = objects[at + (event.shiftKey ? -1 : 1)]

			if (next !== undefined) props.onSelect(next)
			else if (event.shiftKey) {
				props.onSelect(null)
				handle.current?.focus()
			} else if (!focusBeside(event.currentTarget, true)) {
				props.onSelect(null)
				handle.current?.focus()
			}
		} else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
			// Undo and redo, as from the grid.
			void (event.key.toLowerCase() === "y" || event.shiftKey ? grid.redo() : grid.undo())
		} else if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
	}

	return (
		<>
			{objects.map(object => {
				const isSelected = selected === object.key
				const size = sizes.get(object.stamp)

				return (
					<div
						key={object.key}
						className="fo-sheet-object-pane"
						// The selected object (its frame and handles) above the others, whatever its place in z-order.
						style={{
							position: "absolute",
							left: 0,
							top: 0,
							overflow: "hidden",
							visibility: "hidden",
							pointerEvents: "none",
							zIndex: isSelected ? 1 : undefined
						}}
					>
						<div
							ref={element => {
								if (element === null) elements.current.delete(object.key)
								else elements.current.set(object.key, element)
							}}
							className="fo-sheet-object"
							data-object-key={object.key}
							data-selected={isSelected ? "" : undefined}
							role="img"
							aria-label={props.label(object)}
							// The selected object is the grid's one stop among them: Shift+Tab from what follows comes back to it.
							tabIndex={isSelected ? 0 : -1}
							style={{
								position: "absolute",
								left: 0,
								top: 0,
								// On a touch screen an object takes the finger once selected (a tap selects it through the grid,
								// objectAt): until then a pan over it scrolls the grid.
								pointerEvents: isSelected || !coarse ? "auto" : "none",
								touchAction: "none",
								cursor: props.canEdit && !object.noMove ? "move" : "default",
								outline: "none"
							}}
							onPointerDown={event => {
								begin(event, object, null)
							}}
							onPointerMove={follow}
							onPointerUp={event => {
								end(event, true)
							}}
							onPointerCancel={event => {
								end(event, false)
							}}
							onDoubleClick={event => {
								event.stopPropagation()
								props.onActivate?.(object)
							}}
							onKeyDown={event => {
								key(event, object)
							}}
							onWheel={event => {
								// The grid scrolls under the object (its scroller is not an ancestor of the overlays).
								if (event.ctrlKey) return

								const line = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1

								handle.current?.renderer.scrollBy(event.deltaX * line, event.deltaY * line)
							}}
						>
							{!near.has(object.key) && !isSelected ? null : object.kind === "chart" || object.kind === "chartex" ? (
								(props.renderGraphic?.(object, size?.width ?? 0, size?.height ?? 0, size?.scale ?? 1) ?? (
									<ObjectPlaceholder />
								))
							) : (
								<ObjectDrawing
									sheet={sheet}
									object={object}
									source={props.source}
									media={media}
									fitted={fitted}
									size={size}
									version={version}
									ratio={ratio}
									region={
										regions.get(object.stamp) ??
										(isSelected && size !== undefined ? { x: 0, y: 0, width: size.width, height: size.height } : null)
									}
									canvas={!svgOnly.has(object.stamp)}
									onKind={kind => {
										if (kindRef.current.get(object.stamp) === kind) return

										kindRef.current.set(object.stamp, kind)
										// What it covers or what the budget holds may change: placed again in the next frame.
										if (placeSoon.current === null)
											placeSoon.current = requestAnimationFrame(() => {
												placeSoon.current = null
												repaint()
											})
									}}
								/>
							)}
							{isSelected ? (
								<SelectionFrame
									resizable={props.canEdit && !object.noResize}
									onHandle={(event, part) => {
										begin(event, object, part)
									}}
									onMove={follow}
									onEnd={end}
								/>
							) : null}
						</div>
					</div>
				)
			})}
		</>
	)
}

// The topmost object drawn at a point of the page (its key), or null: how a tap selects an object on a touch screen,
// where objects let the finger through to the grid until selected.
export function objectAt(root: ParentNode, clientX: number, clientY: number): number | null {
	const objects = Array.from(root.querySelectorAll<HTMLElement>(".fo-sheet-object[data-object-key]"))

	for (let k = objects.length - 1; k >= 0; k--) {
		const element = objects[k]
		const pane = element?.parentElement

		if (element === undefined || pane === null || pane === undefined || pane.style.visibility === "hidden") continue

		const box = element.getBoundingClientRect()
		const clip = pane.getBoundingClientRect()
		const inside = (rect: DOMRect): boolean =>
			clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom

		if (inside(box) && inside(clip)) return Number(element.dataset["objectKey"])
	}

	return null
}

// The first shown object on screen in z-order (on screen: true), else the sheet's first, for a key that selects one
// (Ctrl+Alt+5); null without any.
export function objectInView(
	handle: SheetGridHandle | null,
	grid: SheetGridModel,
	sheet: SheetId,
	drawings: SheetDrawings | undefined
): { readonly object: SheetDrawingObject; readonly onScreen: boolean } | null {
	const shown = drawings?.objects.filter(object => !object.hidden) ?? []
	const view = handle?.renderer.currentView() ?? null
	const axes = grid.axes(sheet)

	if (view !== null && axes !== null) {
		for (const object of shown)
			if (nearView(view, placeOnScreen(view, anchorBox(object.anchor, axes)).box, 0)) return { object, onScreen: true }
	}

	const first = shown[0]

	return first === undefined ? null : { object: first, onScreen: false }
}

function covering(outer: SheetBox, inner: SheetBox): boolean {
	return (
		outer.x <= inner.x &&
		outer.y <= inner.y &&
		outer.x + outer.width >= inner.x + inner.width &&
		outer.y + outer.height >= inner.y + inner.height
	)
}

// Focus to what follows the grid `from` is in (forward) or what precedes it, the next pane as F6 moves; false when
// nothing does.
export function focusBeside(from: Element, forward: boolean): boolean {
	const root = from.closest(".fo-sheet")

	if (root === null) return false

	const candidates = Array.from(from.ownerDocument.querySelectorAll<HTMLElement>(TABBABLE)).filter(
		element =>
			element.tabIndex >= 0 &&
			!root.contains(element) &&
			!element.matches(":disabled") &&
			element.getClientRects().length > 0 &&
			(root.compareDocumentPosition(element) & (forward ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)) !== 0
	)
	const target = forward ? candidates[0] : candidates.at(-1)

	target?.focus()

	return target !== undefined
}

function sameRegions(a: ReadonlyMap<string, PictureRegion>, b: ReadonlyMap<string, PictureRegion>): boolean {
	if (a.size !== b.size) return false

	for (const [key, region] of b) if (!sameRegion(a.get(key), region)) return false

	return true
}

function sameKeys(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	if (a.size !== b.size) return false

	for (const key of b) if (!a.has(key)) return false

	return true
}

function sameSizes(a: ReadonlyMap<string, ObjectSize>, b: ReadonlyMap<string, ObjectSize>): boolean {
	if (a.size !== b.size) return false

	for (const [key, size] of b) {
		const other = a.get(key)

		if (other === undefined || other.width !== size.width || other.height !== size.height || other.scale !== size.scale) return false
	}

	return true
}

function ObjectPlaceholder() {
	return (
		<div
			className="fo-sheet-object-placeholder"
			style={{
				position: "absolute",
				inset: 0,
				background: "var(--fo-placeholder-fill, #f1f1f1)",
				border: "1px solid var(--fo-placeholder-stroke, #c8c8c8)"
			}}
		/>
	)
}

// Advance widths through a canvas (text the painter wraps); NaN without one.
function measurer(): (text: string, font: string) => number {
	let context: CanvasRenderingContext2D | null | undefined

	return (text, font) => {
		if (context === undefined) {
			try {
				context = document.createElement("canvas").getContext("2d")
			} catch {
				context = null
			}
		}

		if (context === null) return Number.NaN

		context.font = font

		return context.measureText(text).width
	}
}

function deviceRatio(): number {
	return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
}

function fitStep(size: { readonly width: number; readonly height: number } | undefined, ratio: number): string {
	if (size === undefined || size.width < 1 || size.height < 1) return ""

	const step = fittedSize(size.width, size.height, ratio, { left: 0, top: 0, right: 0, bottom: 0 })

	return `${String(step.width)}x${String(step.height)}`
}

interface ShownMedia {
	readonly parts: readonly { readonly partName: string; readonly type: string }[]
	// Object URLs of bitmaps the drawing carries (a metafile's).
	readonly urls: readonly string[]
	// Copies of pictures at the box's size (FittedPictures keys).
	readonly fitted: readonly string[]
}

const NO_MEDIA: ShownMedia = { parts: [], urls: [], fitted: [] }

// One object drawn as SVG once its display list and media are in; a placeholder when it cannot be drawn. The pictures
// the shown drawing uses stay lent until another drawing replaces it or the object goes.
function ObjectDrawing(props: {
	sheet: SheetId
	object: SheetDrawingObject
	source: SheetObjectSource
	media: DocxMediaCache
	fitted: FittedPictures
	// The object's box on screen (CSS px): a picture far larger is shown from a copy of that size.
	size: { readonly width: number; readonly height: number } | undefined
	version: number
	// What of the box near the view a picture on a canvas holds (null: none of it).
	region: PictureRegion | null
	// Device pixels per CSS pixel (it changes with the browser's zoom and the screen).
	ratio: number
	// May it draw on a canvas (false: past the canvases' budget, it draws as SVG).
	canvas: boolean
	// What it draws: a picture on a canvas (opaque: without transparency, over its whole box), or anything else.
	onKind: (kind: CanvasKind) => void
}) {
	const host = useRef<HTMLDivElement>(null)
	const [failed, setFailed] = useState(false)
	// Whether the drawing holds charts (DrawingRender live): then it follows the session's version.
	const [live, setLive] = useState(false)
	// The live stamp of what is shown: asked with it, an unchanged drawing answers "same".
	const shown = useRef<string | undefined>(undefined)
	const shownMedia = useRef<ShownMedia>(NO_MEDIA)
	const { sheet, object, source, media, fitted, onKind } = props
	const allowCanvas = props.canvas
	const followed = live ? props.version : 0
	const { key, stamp } = object
	const picture = object.kind === "picture"
	// A picture on a canvas (canvasPicture.ts): the canvas and how to read its bytes; null for the SVG path.
	const [target, setTarget] = useState<{
		readonly canvas: HTMLCanvasElement
		readonly blob: () => Promise<Blob>
		// The picture's size in pixels (a region decodes only its part); undefined when its header does not say.
		readonly natural: { readonly width: number; readonly height: number } | undefined
	} | null>(null)
	// The canvas path failed here (no createImageBitmap): the SVG path draws it.
	const [noCanvas, setNoCanvas] = useState(false)
	// A picture the SVG path draws: its copy at the box's size is made again when the box's step changes.
	const [svgPicture, setSvgPicture] = useState(false)
	const fitKey = svgPicture ? fitStep(props.size, props.ratio) : ""
	const drawnFor = useRef<object | null>(null)
	const { ratio } = props
	const boxWidth = props.size?.width ?? 0
	const boxHeight = props.size?.height ?? 0
	const { region } = props
	const regionX = region?.x ?? -1
	const regionY = region?.y ?? -1
	const regionWidth = region?.width ?? 0
	const regionHeight = region?.height ?? 0
	const drawnKey = useRef("")
	const sizeRef = useRef(props.size)

	useEffect(() => {
		sizeRef.current = props.size
	})

	useEffect(() => {
		const release = (held: ShownMedia): void => {
			for (const entry of held.parts) media.release(entry.partName, entry.type)
			for (const url of held.urls) media.revokeBytesUrl(url)
			for (const fit of held.fitted) fitted.release(fit)
		}

		return () => {
			release(shownMedia.current)
			shownMedia.current = NO_MEDIA
		}
	}, [media, fitted])

	useEffect(() => {
		let cancelled = false
		const parts: { partName: string; type: string }[] = []
		const urls: string[] = []
		const fits: string[] = []
		const release = (held: ShownMedia): void => {
			for (const entry of held.parts) media.release(entry.partName, entry.type)
			for (const url of held.urls) media.revokeBytesUrl(url)
			for (const fit of held.fitted) fitted.release(fit)
		}

		void (async () => {
			const rendered = await source.render(sheet, key, stamp, shown.current).catch(() => null)

			if (cancelled || rendered?.kind === "same") return

			if (rendered === null || rendered.kind !== "drawing") {
				setFailed(rendered === null || rendered.reason !== "empty")

				return
			}

			if (rendered.live !== undefined) setLive(true)

			const plain = noCanvas || !allowCanvas ? null : canvasPicture(rendered.drawing)

			if (plain !== null) {
				let blob: () => Promise<Blob>
				let natural: { readonly width: number; readonly height: number } | undefined
				let opaque: boolean

				if (plain.kind === "part") {
					parts.push({ partName: plain.partName, type: plain.type })

					const url = await media.acquire(plain.partName, plain.type)

					if (url === undefined) throw new Error("picture unavailable")

					// The cache's own blob (no copy); read through its URL where the cache keeps none.
					natural = media.rasterSize(plain.partName, plain.type)
					opaque = media.opaque(plain.partName, plain.type)
					blob = () => {
						const held = media.blob(plain.partName, plain.type)

						return held === undefined ? fetch(url).then(response => response.blob()) : Promise.resolve(held)
					}
				} else {
					const bytes = new Blob([plain.bytes as Uint8Array<ArrayBuffer>], { type: plain.type })

					natural = rasterSize(plain.bytes)
					opaque = rasterOpaque(plain.bytes)

					blob = () => Promise.resolve(bytes)
				}

				if (cancelled) {
					release({ parts, urls, fitted: fits })

					return
				}

				// The canvas shown stays (and shows what it did) until the new picture is drawn on it.
				const held = host.current?.firstElementChild
				const canvas = held instanceof HTMLCanvasElement ? held : document.createElement("canvas")

				if (canvas !== held) {
					canvas.setAttribute("aria-hidden", "true")
					canvas.style.position = "absolute"
					host.current?.replaceChildren(canvas)
				}

				release(shownMedia.current)
				shownMedia.current = { parts, urls, fitted: fits }
				shown.current = rendered.live
				setTarget({ canvas, blob, natural })
				setFailed(false)
				onKind(opaque ? "opaque" : "canvas")

				return
			}

			setTarget(null)
			onKind("none")

			if (picture) setSvgPicture(true)

			const partUrls = new Map<string, string | undefined>()

			await Promise.all(
				drawingImages(rendered.drawing).map(async image => {
					const partName = image.svgPartName ?? image.partName
					const type = imageMime(image)

					if (partName === undefined || type === "") return

					parts.push({ partName, type })

					const url = await media.acquire(partName, type)

					partUrls.set(partName, url)

					const box = sizeRef.current

					if (
						url === undefined ||
						!picture ||
						box === undefined ||
						box.width < 1 ||
						box.height < 1 ||
						image.svgPartName !== undefined
					)
						return

					const size = fittedSize(box.width, box.height, deviceRatio(), image.crop)

					if (!wantsFit(media.pixels(partName, type), size)) return

					const copy = fitted.acquire(partName, url, size)
					fits.push(copy.key)
					partUrls.set(partName, (await copy.url) ?? url)
				})
			)

			if (cancelled) {
				release({ parts, urls, fitted: fits })

				return
			}

			const inline = inlineImageUrls(rendered.drawing, (bytes, type) => {
				const url = media.createBytesUrl(bytes, type)

				if (url !== undefined) urls.push(url)

				return url
			})
			const svg = paintDrawing(rendered.drawing, {
				document,
				idPrefix: paintId(),
				measureText: measurer(),
				imageUrl: image => inline.get(image) ?? partUrls.get(image.svgPartName ?? image.partName ?? "")
			})

			host.current?.replaceChildren(svg)
			release(shownMedia.current)
			shownMedia.current = { parts, urls, fitted: fits }

			shown.current = rendered.live
			setFailed(false)
		})().catch(() => {
			release({ parts, urls, fitted: fits })

			// The media did not load or the list did not paint: a placeholder stands in.
			if (!cancelled) setFailed(true)
		})

		return () => {
			cancelled = true
		}
	}, [sheet, key, stamp, source, media, fitted, followed, picture, fitKey, noCanvas, allowCanvas])

	// A picture's canvas gives its pixels back when the object goes.
	useEffect(() => {
		const element = host.current

		return () => {
			const canvas = element?.firstElementChild

			if (canvas instanceof HTMLCanvasElement) releaseCanvas(canvas)
		}
	}, [])

	// The canvas's picture: the part of it the region shows, decoded at its device pixels and placed where it stands in
	// the box; the canvas's pixels released when no region holds it.
	useEffect(() => {
		if (target === null) return undefined

		const { canvas, natural } = target

		if (regionWidth <= 0 || regionHeight <= 0 || boxWidth < 1 || boxHeight < 1) {
			releaseCanvas(canvas)
			drawnFor.current = null

			return undefined
		}

		const box = { width: boxWidth, height: boxHeight }
		const asked = { x: regionX, y: regionY, width: regionWidth, height: regionHeight }
		const whole = natural === undefined || (asked.x <= 0 && asked.y <= 0 && asked.width >= boxWidth && asked.height >= boxHeight)
		const source = whole ? undefined : sourceOf(asked, box, natural)
		const shown = source?.region ?? { x: 0, y: 0, width: boxWidth, height: boxHeight }
		const width = Math.max(1, Math.round(shown.width * ratio))
		const height = Math.max(1, Math.round(shown.height * ratio))
		const key = `${String(shown.x)},${String(shown.y)},${String(width)}x${String(height)}`

		if (drawnFor.current === target && drawnKey.current === key) return undefined

		let stale = false

		target
			.blob()
			.then(blob => drawPicture(canvas, blob, width, height, () => stale, source))
			.then(
				drawn => {
					if (!drawn) {
						if (!stale) setNoCanvas(true)

						return
					}

					canvas.style.left = `${String(shown.x)}px`
					canvas.style.top = `${String(shown.y)}px`
					canvas.style.width = `${String(shown.width)}px`
					canvas.style.height = `${String(shown.height)}px`
					drawnFor.current = target
					drawnKey.current = key
				},
				() => {
					if (!stale) setNoCanvas(true)
				}
			)

		return () => {
			stale = true
		}
	}, [target, boxWidth, boxHeight, regionX, regionY, regionWidth, regionHeight, ratio])

	return (
		<>
			<div
				ref={host}
				style={{ position: "absolute", inset: 0, pointerEvents: "none", visibility: failed ? "hidden" : undefined }}
			/>
			{failed ? <ObjectPlaceholder /> : null}
		</>
	)
}

function SelectionFrame(props: {
	resizable: boolean
	onHandle: (event: PointerEvent<HTMLElement>, handle: Handle) => void
	onMove: (event: PointerEvent<HTMLElement>) => void
	onEnd: (event: PointerEvent<HTMLElement>, commit: boolean) => void
}) {
	return (
		<div
			className="fo-sheet-object-frame"
			style={{
				position: "absolute",
				inset: 0,
				outline: "1px solid var(--fo-sheet-selection-line, #1e3a8a)",
				boxShadow: "0 0 0 2px var(--fo-sheet-selection-halo, rgba(255, 255, 255, 0.85))",
				pointerEvents: "none"
			}}
		>
			{props.resizable
				? HANDLES.map(handle => (
						<div
							key={handle}
							data-handle={handle}
							className="fo-sheet-object-handle"
							style={{
								position: "absolute",
								left: handle.includes("w") ? 0 : handle.includes("e") ? "100%" : "50%",
								top: handle.startsWith("n") ? 0 : handle.startsWith("s") ? "100%" : "50%",
								width: "var(--fo-sheet-object-handle-hit, 24px)",
								height: "var(--fo-sheet-object-handle-hit, 24px)",
								transform: "translate(-50%, -50%)",
								pointerEvents: "auto",
								touchAction: "none",
								cursor: `${handle}-resize`
							}}
							onPointerDown={event => {
								event.stopPropagation()
								props.onHandle(event, handle)
							}}
							onPointerMove={props.onMove}
							onPointerUp={event => {
								props.onEnd(event, true)
							}}
							onPointerCancel={event => {
								props.onEnd(event, false)
							}}
						>
							<span
								style={{
									position: "absolute",
									left: "50%",
									top: "50%",
									width: 8,
									height: 8,
									transform: "translate(-50%, -50%)",
									background: "var(--fo-sheet-object-handle, #ffffff)",
									border: "1px solid var(--fo-sheet-selection-line, #1e3a8a)",
									borderRadius: 2
								}}
							/>
						</div>
					))
				: null}
		</div>
	)
}
