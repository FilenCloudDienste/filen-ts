import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { EMU_PER_PX } from "../../../../core/drawingml/reader"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../../../core/presentation/budget"
import {
	deletePoint,
	insertPoint,
	moveHandle,
	movePoint,
	nearestPoint,
	nearestSegment,
	readEditablePath,
	type EditablePath
} from "../../../../core/anim/motionEdit"
import { PathDrawing, type MotionTool } from "./draw"
import {
	anchorsData,
	drawingData,
	editableData,
	handlesData,
	handlesOf,
	markersData,
	pathPoint,
	placementOf,
	playedPoints,
	polylineData,
	screenX,
	screenY,
	type Placement,
	type SlideSize
} from "./geometry"

// The motion paths of the slide in view on the editor's canvas (SlideView's overlay slot, screen px), above the shape
// layer: each path dotted from a green start marker to a red end marker (PowerPoint's look), a click on one choosing
// its effect; the Draw Custom Path tools; and Edit Points on one path (its anchors, the selected anchor's handles,
// dragging either, a press on a segment adding a point there, Delete removing the selected one).
//
// A drag never renders through React: each animation frame computes the edited path from the path the drag began on
// and sets the SVG elements' path data directly; the drop sends one edit (one op, one undo step). The edited path is
// shown until the slide's timing comes back with it.

export interface MotionPathView {
	// The animMotion behaviour's ctn id.
	readonly node: number
	// Its effect's ctn id.
	readonly effect: number
	readonly shape: number
	readonly path: string
	readonly ptsTypes?: string
	readonly pathEditMode?: "relative" | "fixed"
	// The shape's centre as rendered, EMU.
	readonly center: { readonly x: number; readonly y: number }
}

export interface MotionPathLabels {
	// The layer's accessible name while drawing or editing points.
	readonly drawing: string
	readonly editing: string
	// What the live region says about the selected point (index from 1).
	point(index: number, count: number): string
}

export interface MotionPathLayerProps {
	readonly size: SlideSize
	// Screen px per slide px (SlideView's onScale).
	readonly scale: number
	readonly paths: readonly MotionPathView[]
	// Effect ids shown as chosen.
	readonly selected: readonly number[]
	readonly editable: boolean
	// Whether a click on a path chooses its effect (while the Animation Pane is open): otherwise a path never covers
	// the shapes under it.
	readonly pickable: boolean
	// The tool drawing a new path, and the centre (EMU) of the shape it will move.
	readonly tool?: MotionTool
	readonly origin?: { readonly x: number; readonly y: number }
	// The behaviour in Edit Points, and its selected anchor.
	readonly editing?: number
	readonly point?: number
	readonly labels: MotionPathLabels
	// The timing budget's motion segments (the player's own limit) for paths drawn as the player flattens them.
	readonly maxSegments?: number
	onSelect(effect: number): void
	// A path drawn with `tool`, relative to `origin`; undefined when the tool was left without one.
	onDrawn(path: EditablePath | undefined): void
	// One edit of `node`'s path (a drag, a key).
	onEdit(node: number, path: EditablePath): void
	onPoint(index: number | undefined): void
	// Edit Points left (Escape, a press away from the path).
	onEditEnd(): void
}

const PATH = "var(--fo-motion, #2563eb)"
const CHOSEN = "var(--fo-motion-chosen, #1d4ed8)"
const START = "var(--fo-motion-start, #16a34a)"
const END = "var(--fo-motion-end, #dc2626)"
// Grab radius around anchors, handles and segments (screen px).
const GRAB_PX = 8

type Drag =
	| { readonly kind: "point"; readonly index: number; readonly base: EditablePath; readonly pointer: number; moved: boolean }
	| {
			readonly kind: "handle"
			readonly segment: number
			readonly end: 0 | 1
			readonly base: EditablePath
			readonly pointer: number
			moved: boolean
	  }

// The selected anchor, drawn larger and filled.
function pointData(placement: Placement, path: EditablePath, index: number): string {
	return anchorsData(placement, { ...path, xs: path.xs.subarray(index, index + 1), ys: path.ys.subarray(index, index + 1) }, 4.5)
}

// The keyboard cursor: a cross at a slide fraction (screen px).
function crossData(at: { readonly x: number; readonly y: number }, k: number, size: SlideSize): string {
	const x = at.x * size.cx * k
	const y = at.y * size.cy * k
	const arm = 6

	return `M${(x - arm).toFixed(1)} ${y.toFixed(1)}H${(x + arm).toFixed(1)}M${x.toFixed(1)} ${(y - arm).toFixed(1)}V${(y + arm).toFixed(1)}`
}

function aspectOf(size: SlideSize): number {
	return size.cy > 0 ? size.cx / size.cy : 1
}

export function MotionPathLayer(props: MotionPathLayerProps) {
	const { size, scale, paths, selected, editable, pickable, tool, origin, editing, point, labels } = props
	const maxSegments = props.maxSegments ?? DEFAULT_PRESENTATION_BUDGETS.timing.motionSegments
	const rootRef = useRef<HTMLDivElement | null>(null)
	const editRef = useRef<SVGPathElement | null>(null)
	const anchorsRef = useRef<SVGPathElement | null>(null)
	const handleLinesRef = useRef<SVGPathElement | null>(null)
	const handleDotsRef = useRef<SVGPathElement | null>(null)
	const chosenPointRef = useRef<SVGPathElement | null>(null)
	const drawRef = useRef<SVGPathElement | null>(null)
	const cursorMarkRef = useRef<SVGPathElement | null>(null)
	const drawingRef = useRef<PathDrawing | undefined>(undefined)
	// The keyboard cursor of a drawing tool (slide fractions), once an arrow key or Space is used.
	const cursorRef = useRef<{ x: number; y: number } | undefined>(undefined)
	// What had focus before the layer took it for a tool or Edit Points: it gets it back when they end.
	const returnRef = useRef<HTMLElement | null>(null)
	const dragRef = useRef<Drag | undefined>(undefined)
	const frameRef = useRef(0)
	const pendingRef = useRef<{ x: number; y: number } | undefined>(undefined)
	// An edit sent and not yet back in `paths`: the path shown meanwhile, and the path text it replaces.
	const [expected, setExpected] = useState<{ readonly node: number; readonly path: EditablePath; readonly from: string } | undefined>(
		undefined
	)
	const k = scale / EMU_PER_PX
	const liveId = useId()
	const editingView = editing === undefined ? undefined : paths.find(view => view.node === editing)
	const placement: Placement | undefined = editingView === undefined ? undefined : placementOf(editingView.center, size, scale)
	const parsed = editingView === undefined ? undefined : readEditablePath(editingView.path, editingView.ptsTypes)
	const fromFile = parsed === undefined || "reason" in parsed ? undefined : parsed
	const working = expected !== undefined && expected.node === editing && editingView?.path === expected.from ? expected.path : fromFile

	// The edit came back (or the path changed some other way): show the path as the slide has it.
	useEffect(() => {
		if (expected !== undefined && (editingView === undefined || editingView.path !== expected.from)) setExpected(undefined)
	}, [expected, editingView?.path])

	const takeFocus = (): void => {
		const root = rootRef.current
		const before = root?.ownerDocument.activeElement

		if (before instanceof HTMLElement && before !== root && before !== root?.ownerDocument.body) returnRef.current = before

		root?.focus({ preventScroll: true })
	}

	// A new tool starts a new drawing; leaving the tool drops it.
	useLayoutEffect(() => {
		drawingRef.current = tool === undefined ? undefined : new PathDrawing(tool, { width: size.cx * k, height: size.cy * k })
		cursorRef.current = undefined
		drawRef.current?.setAttribute("d", "")
		cursorMarkRef.current?.setAttribute("d", "")

		if (tool !== undefined) takeFocus()
	}, [tool])

	useLayoutEffect(() => {
		if (editing !== undefined) takeFocus()
	}, [editing])

	useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

	const local = (event: { readonly clientX: number; readonly clientY: number }): { x: number; y: number } => {
		const rect = rootRef.current?.getBoundingClientRect()

		return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
	}

	// The slide fraction under a screen point (from the slide's top left).
	const slideFraction = (x: number, y: number): { x: number; y: number } => ({
		x: size.cx > 0 && k > 0 ? x / k / size.cx : 0,
		y: size.cy > 0 && k > 0 ? y / k / size.cy : 0
	})

	const drawPreview = (): void => {
		const drawing = drawingRef.current
		const cursor = cursorRef.current

		drawRef.current?.setAttribute("d", drawing === undefined ? "" : drawingData(drawing.preview(), drawing.tool === "curve", k, size))
		cursorMarkRef.current?.setAttribute("d", drawing === undefined || cursor === undefined ? "" : crossData(cursor, k, size))
	}

	const paintEdit = (path: EditablePath, index: number | undefined): void => {
		if (placement === undefined) return

		const handles = index === undefined ? { lines: "", dots: "" } : handlesData(placement, path, index)

		editRef.current?.setAttribute("d", editableData(placement, path))
		anchorsRef.current?.setAttribute("d", anchorsData(placement, path))
		handleLinesRef.current?.setAttribute("d", handles.lines)
		handleDotsRef.current?.setAttribute("d", handles.dots)
		chosenPointRef.current?.setAttribute("d", index === undefined ? "" : pointData(placement, path, index))
	}

	const dragged = (drag: Drag, at: { x: number; y: number }): EditablePath => {
		const target = placement === undefined ? { x: 0, y: 0 } : pathPoint(placement, at.x, at.y)

		return drag.kind === "point"
			? movePoint(drag.base, drag.index, target.x, target.y)
			: moveHandle(drag.base, drag.segment, drag.end, target.x, target.y)
	}

	const schedule = (): void => {
		if (frameRef.current !== 0) return

		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = 0

			const at = pendingRef.current
			const drag = dragRef.current

			if (drag !== undefined && at !== undefined) paintEdit(dragged(drag, at), drag.kind === "point" ? drag.index : point)
			else drawPreview()
		})
	}

	const finishDrawing = (cancelled: boolean): void => {
		const drawing = drawingRef.current

		drawingRef.current = undefined
		drawRef.current?.setAttribute("d", "")

		const drawn =
			cancelled || drawing === undefined || origin === undefined
				? undefined
				: drawing.result(slideFraction(origin.x * k, origin.y * k))

		props.onDrawn(drawn === undefined || "reason" in drawn ? undefined : drawn)
	}

	const commit = (node: number, from: string, path: EditablePath): void => {
		setExpected({ node, path, from })
		props.onEdit(node, path)
	}

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (!editable || event.button > 0) return

		const at = local(event)
		const drawing = drawingRef.current

		if (drawing !== undefined) {
			event.preventDefault()
			event.currentTarget.setPointerCapture(event.pointerId)

			const fraction = slideFraction(at.x, at.y)

			if (drawing.down(fraction.x, fraction.y, event.timeStamp) === "done") finishDrawing(false)
			else schedule()

			return
		}

		if (editingView === undefined || working === undefined || placement === undefined) return

		const fraction = pathPoint(placement, at.x, at.y)
		const aspect = aspectOf(size)
		const radius = GRAB_PX / Math.max(1, size.cy * k)

		// The selected anchor's handles first, then any anchor, then a segment (a new point there).
		if (point !== undefined) {
			for (const handle of handlesOf(working, point)) {
				const hx = screenX(placement, working.controls[handle.offset] ?? 0)
				const hy = screenY(placement, working.controls[handle.offset + 1] ?? 0)

				if (Math.hypot(hx - at.x, hy - at.y) <= GRAB_PX) {
					event.preventDefault()
					event.currentTarget.setPointerCapture(event.pointerId)
					dragRef.current = {
						kind: "handle",
						segment: handle.segment,
						end: handle.end,
						base: working,
						pointer: event.pointerId,
						moved: false
					}

					return
				}
			}
		}

		const anchor = nearestPoint(working, fraction.x, fraction.y, radius, aspect)
		let base = working
		let index = anchor

		if (anchor < 0) {
			const segment = nearestSegment(working, fraction.x, fraction.y, radius, aspect)

			if (segment === undefined) {
				props.onEditEnd()

				return
			}

			base = insertPoint(working, segment.segment, segment.t)
			index = segment.segment + 1
		}

		event.preventDefault()
		event.currentTarget.setPointerCapture(event.pointerId)
		props.onPoint(index)
		// A point added on a segment is an edit even without a drag.
		dragRef.current = { kind: "point", index, base, pointer: event.pointerId, moved: base !== working }
		paintEdit(base, index)
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current
		const at = local(event)

		if (drag !== undefined) {
			if (event.pointerId !== drag.pointer) return

			drag.moved = true
			pendingRef.current = at
			schedule()

			return
		}

		const drawing = drawingRef.current

		if (drawing === undefined) return

		const fraction = slideFraction(at.x, at.y)

		drawing.move(fraction.x, fraction.y)
		schedule()
	}

	const onPointerUp = (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
		const drag = dragRef.current
		const at = local(event)

		if (drag !== undefined) {
			if (event.pointerId !== drag.pointer) return

			dragRef.current = undefined
			pendingRef.current = undefined
			cancelAnimationFrame(frameRef.current)
			frameRef.current = 0

			if (cancelled || !drag.moved || editingView === undefined) {
				if (working !== undefined) paintEdit(working, point)

				return
			}

			const next = dragged(drag, at)

			paintEdit(next, drag.kind === "point" ? drag.index : point)
			commit(editingView.node, editingView.path, next)

			return
		}

		const drawing = drawingRef.current

		if (drawing === undefined) return

		if (cancelled) {
			finishDrawing(true)

			return
		}

		const fraction = slideFraction(at.x, at.y)

		if (drawing.up(fraction.x, fraction.y) === "done") finishDrawing(false)
		else schedule()
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const drawing = drawingRef.current

		if (drawing !== undefined) {
			if (event.key === "Escape") {
				event.preventDefault()
				finishDrawing(true)
			} else if (event.key === "Enter") {
				event.preventDefault()

				if (drawing.finishNow() === "done") finishDrawing(false)
			} else if (drawing.tool !== "scribble" && (event.key === " " || event.key.startsWith("Arrow"))) {
				event.preventDefault()

				// The cursor starts at the object's centre and moves one screen px a press (ten with Shift).
				const cursor = cursorRef.current ?? slideFraction((origin?.x ?? 0) * k, (origin?.y ?? 0) * k)
				const step = k > 0 ? (event.shiftKey ? 10 : 1) / k : 0
				const x = Math.min(
					1,
					Math.max(
						0,
						cursor.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0) / Math.max(1, size.cx)
					)
				)
				const y = Math.min(
					1,
					Math.max(0, cursor.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) / Math.max(1, size.cy))
				)

				cursorRef.current = { x, y }

				if (event.key === " ") {
					if (drawing.place(x, y) === "done") {
						finishDrawing(false)

						return
					}
				} else drawing.hover(x, y)

				schedule()
			}

			return
		}

		if (editingView === undefined || working === undefined || placement === undefined) return

		const count = working.xs.length

		switch (event.key) {
			case "Escape":
				event.preventDefault()
				props.onEditEnd()

				return
			case "Tab": {
				event.preventDefault()

				const from = point ?? (event.shiftKey ? 0 : -1)

				props.onPoint((from + (event.shiftKey ? -1 : 1) + count) % count)

				return
			}
			case "Delete":
			case "Backspace": {
				if (point === undefined) return

				event.preventDefault()

				const next = deletePoint(working, point)

				if (next === working) return

				props.onPoint(Math.min(point, next.xs.length - 1))
				commit(editingView.node, editingView.path, next)

				return
			}
			case "ArrowLeft":
			case "ArrowRight":
			case "ArrowUp":
			case "ArrowDown": {
				if (point === undefined) return

				event.preventDefault()

				// One screen px (ten with Shift), as a slide fraction.
				const step = k > 0 ? (event.shiftKey ? 10 : 1) / k : 0
				const dx = event.key === "ArrowLeft" ? -step / size.cx : event.key === "ArrowRight" ? step / size.cx : 0
				const dy = event.key === "ArrowUp" ? -step / size.cy : event.key === "ArrowDown" ? step / size.cy : 0

				commit(
					editingView.node,
					editingView.path,
					movePoint(working, point, (working.xs[point] ?? 0) + dx, (working.ys[point] ?? 0) + dy)
				)

				return
			}
			default:
		}
	}

	const active = editable && (tool !== undefined || editingView !== undefined)
	const chosen = new Set(selected)

	// A tool or Edit Points ended with the focus on the layer (or lost with its role): back where it was before.
	useLayoutEffect(() => {
		if (active) return

		const root = rootRef.current
		const back = returnRef.current
		const focused = root?.ownerDocument.activeElement

		returnRef.current = null

		// Focus left on the layer falls back to an element around it (the body, the editor's overlay).
		if (back?.isConnected === true && root !== null && (focused === null || focused === undefined || focused.contains(root)))
			back.focus({ preventScroll: true })
	}, [active])

	return (
		<div
			ref={rootRef}
			className="fo-motion-paths"
			data-fo-motion-paths=""
			{...(active
				? {
						role: "application",
						"aria-label": tool !== undefined ? labels.drawing : labels.editing,
						"aria-describedby": liveId,
						tabIndex: 0
					}
				: { "aria-hidden": true })}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: active ? "auto" : "none",
				cursor: tool !== undefined ? "crosshair" : undefined,
				touchAction: active ? "none" : undefined,
				outline: "none"
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={event => {
				onPointerUp(event, false)
			}}
			onPointerCancel={event => {
				onPointerUp(event, true)
			}}
			onKeyDown={onKeyDown}
		>
			<svg
				aria-hidden="true"
				style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
			>
				{paths.map(view => {
					const at = placementOf(view.center, size, scale)
					const isEditing = view.node === editingView?.node && working !== undefined
					const flat = playedPoints(view.path, size, maxSegments)
					const markers = markersData(flat, at)
					const d = isEditing ? editableData(at, working) : polylineData(at, flat)
					const isChosen = chosen.has(view.effect)

					return (
						<g key={view.node}>
							{/* A wide invisible stroke takes the click that chooses the effect. */}
							{editable && pickable && !active ? (
								<path
									d={d}
									fill="none"
									stroke="transparent"
									strokeWidth={GRAB_PX * 1.5}
									style={{ pointerEvents: "stroke", cursor: "pointer" }}
									data-fo-motion-path={view.node}
									onPointerDown={event => {
										event.stopPropagation()
										props.onSelect(view.effect)
									}}
								/>
							) : null}
							<path
								{...(isEditing ? { ref: editRef } : {})}
								d={d}
								fill="none"
								stroke={isChosen || isEditing ? CHOSEN : PATH}
								strokeWidth={isChosen || isEditing ? 2 : 1.25}
								strokeDasharray={isEditing ? undefined : "4 3"}
							/>
							<path
								d={markers.start}
								fill={START}
							/>
							<path
								d={markers.end}
								fill={END}
							/>
						</g>
					)
				})}
				{working !== undefined && placement !== undefined ? (
					<>
						<path
							ref={handleLinesRef}
							d={point === undefined ? "" : handlesData(placement, working, point).lines}
							fill="none"
							stroke={CHOSEN}
							strokeWidth={1}
						/>
						<path
							ref={anchorsRef}
							d={anchorsData(placement, working)}
							fill="var(--fo-handle, #fff)"
							stroke={CHOSEN}
							strokeWidth={1}
						/>
						<path
							ref={chosenPointRef}
							d={point === undefined ? "" : pointData(placement, working, point)}
							fill={CHOSEN}
						/>
						<path
							ref={handleDotsRef}
							d={point === undefined ? "" : handlesData(placement, working, point).dots}
							fill="var(--fo-handle, #fff)"
							stroke={CHOSEN}
							strokeWidth={1}
						/>
					</>
				) : null}
				<path
					ref={drawRef}
					d=""
					fill="none"
					stroke={CHOSEN}
					strokeWidth={1.5}
					strokeDasharray="4 3"
				/>
				<path
					ref={cursorMarkRef}
					d=""
					fill="none"
					stroke={CHOSEN}
					strokeWidth={1.5}
				/>
			</svg>
			<div
				id={liveId}
				aria-live="polite"
				style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}
			>
				{working !== undefined && point !== undefined ? labels.point(point + 1, working.xs.length) : ""}
			</div>
		</div>
	)
}
