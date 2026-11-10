import { isMacPlatform } from "@filen/shared/keymap"
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { EMU_PER_PX } from "../../../core/drawingml/reader"
import { canZOrder, zOrderOp } from "../../../core/presentation/edit/commands/arrange"
import { canGroup, groupOp, ungroupOps } from "../../../core/presentation/edit/commands/group"
import {
	ROTATE_SNAP,
	canMove,
	deleteOp,
	duplicateOp,
	lineEnds,
	nudgeOp,
	steppedShapes,
	turnedShapes,
	xfrmsOp,
	type PlacedShape
} from "../../../core/presentation/edit/commands/shape"
import type { DeckOp } from "../../../core/presentation/edit/ops"
import type { ShapeRef, SlideGrid, SlideRef, Xfrm } from "../../../core/presentation/model"
import type { SlideRender } from "../../../core/presentation/output"
import type { CommandResult, PresentationSessionApi } from "../../../dom/presentation/protocol"
import { snapThreshold, type Guide, type Spacing } from "./guides"
import {
	DRAG_START_PX,
	HANDLE_GRAB_PX,
	ROTATE_OFFSET_PX,
	ShapeDrag,
	boxHandles,
	boxPoint,
	handleAt,
	handleCursor,
	handlePoint,
	hasEndHandles,
	hasRotateHandle,
	multiply,
	previewMatrix,
	rotatePoint,
	type DragModifiers,
	type HandleHit,
	type Point,
	type ShapeDragOptions
} from "./handles"
import { Z_ORDER_OF, cycleTarget, objectKeyAction, type ObjectCommand, type ObjectKeyBindings } from "./keyboard"
import {
	boundsOf,
	clickTarget,
	hitPath,
	placements,
	selectable,
	selectedShapes,
	selectionGroup,
	shapeOf,
	shapesInside,
	siblingShapes,
	slideShapes,
	useShapeSelection,
	type Bounds,
	type ShapeSelection,
	type SlideShape
} from "./selection"
import { formatShapesOp, type TextEditing } from "./text/editing"
import { defaultTextBindings, formatKey, textKeyCommand, type TextKeyBindings } from "./text/keys"

// The editor's layer over the slide (SlideView's overlay slot, the frame's size, screen px): the selection's frames
// and handles, the marquee and the smart guides, and the pointer and keys that select, move, resize, turn and
// arrange shapes. A drag is shown by transforming the painted layers (CSS), drawn once per animation frame, and ends
// in one op; the worker renders the slide again only after the drop. The boxes the op wrote are shown until the
// render that has them arrives, so keys pressed in a row (nudges) build on each other.

export interface ShapeEditLabels {
	// The canvas's accessible name.
	readonly canvas: string
	// Its accessible description: the keys that leave it (F6 to the ribbon), since Tab moves between shapes.
	readonly keys?: string
	// What the live region says about the selection (empty: nothing selected).
	describe(shapes: readonly SlideShape[]): string
}

export interface ShapeEditLayerProps {
	readonly render: SlideRender | undefined
	// The slide's size, EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	// The grid drags snap to when its `snap` is set (OpenInfo's grid); absent: none.
	readonly grid?: SlideGrid
	// Screen px per slide px (SlideView's onScale).
	readonly scale: number
	readonly selection: ShapeSelection
	readonly editable: boolean
	readonly bindings: ObjectKeyBindings
	readonly labels: ShapeEditLabels
	readonly command: (op: DeckOp) => Promise<CommandResult>
	// A double click or Enter on one shape: edit its text.
	// `at`: where a double-click entered it (slide px), for the first caret; absent from the keyboard (Enter, F2).
	// `selectAll`: the body opens with its text selected (Enter, as PowerPoint's).
	readonly onEnterText?: (
		shape: ShapeRef,
		at?: { readonly x: number; readonly y: number },
		options?: { readonly selectAll?: boolean }
	) => void
	// The shapes' text without a body open: a character typed on a selected shape opens its body with that character
	// (`editing` holds it, and what follows, until the body is ready), and the body's formatting keys (`bindings`,
	// PowerPoint's by default) format the whole text of the selected shapes, seeded from `session`, as one op.
	readonly text?: {
		readonly editing: TextEditing
		readonly session: Pick<PresentationSessionApi, "textSeed">
		readonly bindings?: TextKeyBindings
	}
}

// More selected shapes than this show their frames only (no handles): a marquee over a busy slide stays cheap.
export const HANDLES_LIMIT = 64

// How far (screen px) the layer reaches past the slide on every side, so handles drawn outside it (a rotate handle
// above a shape at the top edge, half of every edge handle) still take a press, with a finger too.
export const HIT_MARGIN_PX = ROTATE_OFFSET_PX + 2 * HANDLE_GRAB_PX
// Keys whose press or release during a drag changes it without the pointer moving (Ctrl copies, Shift constrains).
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"])

const FRAME = "var(--fo-selection, #2563eb)"
const GUIDE = "var(--fo-guide, #ec4899)"

interface Pending {
	readonly start: Point
	readonly screen: Point
	readonly kind: "move" | "marquee"
	readonly additive: boolean
	readonly before: readonly number[]
	// A modifier press on a selected shape: it leaves the selection on release, unless the press became a drag.
	readonly deselect?: number
	// A plain press on a shape a click puts the caret in: its body opens on a release without a drag.
	readonly enter?: number
	// A plain press on a selected group over one of its members: the member is selected on a release without a drag
	// (`intoEnters`: and its body opened where the press landed, for a text box or placeholder).
	readonly into?: number
	readonly intoEnters?: boolean
}

// Whether a shape's text can be entered (a double-click, Enter): one with a body, not drawn as a line. A picture, a
// group, a chart or a medium has none (PowerPoint opens its tab or its child instead, never an error).
function holdsText(shape: SlideShape): boolean {
	return shape.body !== undefined && shape.line !== true && shape.media === undefined
}

// A click puts the caret in a placeholder, a text box or a table's cell (PowerPoint); it only selects another shape.
function clickEntersText(shape: SlideShape): boolean {
	return holdsText(shape) && shape.body !== "shape"
}

// A shape with one body, which typing on it adds to and the formatting keys format whole while it is selected (a
// table's cells take either only once one is entered).
function oneBody(shape: SlideShape): boolean {
	return holdsText(shape) && shape.body !== "table"
}

// A selected shape as the commands take it: the box the editor shows (an op's, until its render arrives), with the
// file's locks and whether it is a line.
function placedOf(shape: SlideShape, expected: ReadonlyMap<number, Xfrm> | undefined): PlacedShape {
	return {
		id: shape.id,
		xfrm: expected?.get(shape.id) ?? shape.xfrm,
		...(shape.locks === undefined ? {} : { locks: shape.locks }),
		...(shape.line === true ? { line: true as const } : {}),
		...(shape.space === undefined ? {} : { space: shape.space })
	}
}

// The top-level shape a shape is in (itself at the slide's level).
function outermostOf(render: SlideRender | undefined, shape: SlideShape): SlideShape {
	let at = shape

	for (let depth = 0; at.parent !== undefined && depth < 129; depth++) {
		const parent = shapeOf(render, at.parent)

		if (parent === undefined) break

		at = parent
	}

	return at
}

// The app's one Mac test (Mod is Cmd), shared with its keymap so the canvas and the app agree.
const isApple = isMacPlatform

function cssMatrix(matrix: readonly number[]): string {
	return `matrix(${matrix.map(value => String(Math.round((Number.isFinite(value) ? value : 0) * 10000) / 10000)).join(",")})`
}

function sameBox(a: Xfrm, b: Xfrm): boolean {
	return a.x === b.x && a.y === b.y && a.cx === b.cx && a.cy === b.cy && a.rot === b.rot && a.flipH === b.flipH && a.flipV === b.flipV
}

// Within the rounding a box takes through a group's child space and back (a few EMU, a 1/60,000° turn).
function nearBox(a: Xfrm, b: Xfrm): boolean {
	const near = (p: number, q: number, slack: number): boolean => Math.abs(p - q) <= slack
	const turn = Math.abs(a.rot - b.rot)

	return (
		near(a.x, b.x, 4) &&
		near(a.y, b.y, 4) &&
		near(a.cx, b.cx, 4) &&
		near(a.cy, b.cy, 4) &&
		(turn <= 1 || turn >= 21_600_000 - 1) &&
		a.flipH === b.flipH &&
		a.flipV === b.flipV
	)
}

// The SVG path of the boxes' outlines and of their handles (screen px).
function framePaths(shapes: readonly PlacedShape[], scale: number, handles: boolean): { outline: string; handles: string; rotate: string } {
	const k = scale / EMU_PER_PX
	const emuPerScreenPx = scale > 0 ? EMU_PER_PX / scale : EMU_PER_PX
	const offset = ROTATE_OFFSET_PX * emuPerScreenPx
	const at = (point: Point): string => `${(point.x * k).toFixed(1)} ${(point.y * k).toFixed(1)}`
	let outline = ""
	let squares = ""
	let rotate = ""

	const dot = (point: Point): string => `M${(point.x * k - 4).toFixed(1)} ${(point.y * k).toFixed(1)}a4 4 0 1 0 8 0a4 4 0 1 0 -8 0`

	for (const shape of shapes) {
		const xfrm = shape.xfrm

		// A line shows as itself with a handle on each end (PowerPoint), any other shape as its box.
		if (shape.line === true) {
			const ends = lineEnds(xfrm)

			outline += `M${at(ends.start)}L${at(ends.end)}`

			if (handles && hasEndHandles(shape)) squares += dot(ends.start) + dot(ends.end)

			continue
		}

		outline += `M${at(boxPoint(xfrm, 0, 0))}L${at(boxPoint(xfrm, 1, 0))}L${at(boxPoint(xfrm, 1, 1))}L${at(boxPoint(xfrm, 0, 1))}Z`

		if (!handles) continue

		for (const handle of boxHandles(shape, emuPerScreenPx)) {
			const point = handlePoint(xfrm, handle)

			squares += `M${(point.x * k - 4).toFixed(1)} ${(point.y * k - 4).toFixed(1)}h8v8h-8Z`
		}

		if (!hasRotateHandle(shape)) continue

		const top = boxPoint(xfrm, 0.5, 0)
		const knob = rotatePoint(xfrm, offset)
		const x = knob.x * k
		const y = knob.y * k

		rotate += `M${at(top)}L${at(knob)}M${(x - 5).toFixed(1)} ${y.toFixed(1)}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`
	}

	return { outline, handles: squares, rotate }
}

function guidePath(guides: readonly Guide[], spacing: readonly Spacing[], scale: number): string {
	const k = scale / EMU_PER_PX
	let path = ""

	for (const guide of guides) {
		const at = (guide.at * k).toFixed(1)

		path +=
			guide.axis === "x"
				? `M${at} ${(guide.from * k).toFixed(1)}V${(guide.to * k).toFixed(1)}`
				: `M${(guide.from * k).toFixed(1)} ${at}H${(guide.to * k).toFixed(1)}`
	}

	for (const mark of spacing) {
		const from = mark.from * k
		const to = mark.to * k
		const at = mark.at * k

		path +=
			mark.axis === "x"
				? `M${from.toFixed(1)} ${at.toFixed(1)}H${to.toFixed(1)}M${from.toFixed(1)} ${(at - 4).toFixed(1)}v8M${to.toFixed(1)} ${(at - 4).toFixed(1)}v8`
				: `M${at.toFixed(1)} ${from.toFixed(1)}V${to.toFixed(1)}M${(at - 4).toFixed(1)} ${from.toFixed(1)}h8M${(at - 4).toFixed(1)} ${to.toFixed(1)}h8`
	}

	return path
}

export function ShapeEditLayer({
	render,
	size,
	grid,
	scale,
	selection,
	editable,
	bindings,
	labels,
	command,
	onEnterText,
	text
}: ShapeEditLayerProps) {
	const state = useShapeSelection(selection)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const outlineRef = useRef<SVGPathElement | null>(null)
	const handlesRef = useRef<SVGPathElement | null>(null)
	const rotateRef = useRef<SVGPathElement | null>(null)
	const guidesRef = useRef<SVGPathElement | null>(null)
	const marqueeRef = useRef<SVGRectElement | null>(null)
	const dragRef = useRef<ShapeDrag | undefined>(undefined)
	const pendingRef = useRef<Pending | undefined>(undefined)
	// The pointer a press or drag follows: any other (a second finger, a pen beside a finger) is ignored until it ends.
	const pointerRef = useRef<number | undefined>(undefined)
	const frameRef = useRef<{ point: Point; modifiers: DragModifiers; screen: Point } | undefined>(undefined)
	const rafRef = useRef(0)
	// Painted layer elements transformed by a preview, with the transform they had.
	const previewedRef = useRef(new Map<HTMLElement, string>())
	// Boxes an op wrote that the render does not show yet, and the commands still running.
	const [expected, setExpected] = useState<ReadonlyMap<number, Xfrm> | undefined>(undefined)
	const inflightRef = useRef(0)
	const missesRef = useRef(0)
	// The formatting keys' runs on selected shapes, one after another.
	const formattingRef = useRef<Promise<void>>(Promise.resolve())
	const shapes = slideShapes(render)
	const slide: SlideRef | undefined = render?.ref
	const selected = selectedShapes(render, state)
	const placed: PlacedShape[] = selected.map(shape => placedOf(shape, expected))
	// Members of one group selected: that group (framed dashed), and the shapes at their level (what Tab, Select All
	// and the z-order commands go through); else the slide's top-level shapes.
	const group = selectionGroup(render, selected)
	const level = group === undefined ? shapes : siblingShapes(render, selected[0])
	const emuPerScreenPx = scale > 0 ? EMU_PER_PX / scale : EMU_PER_PX

	// The layer elements of the painted slide, by layer index.
	const layerElements = (): Map<number, HTMLElement> => {
		const out = new Map<number, HTMLElement>()
		const frame = rootRef.current?.closest(".fo-slide-frame") ?? rootRef.current?.parentElement

		if (frame === null || frame === undefined) return out

		for (const element of frame.querySelectorAll<HTMLElement>(".fo-slide-content [data-fo-layer]")) {
			out.set(Number(element.dataset["foLayer"]), element)
		}

		return out
	}

	const restorePreview = (): void => {
		for (const [element, transform] of previewedRef.current) element.style.transform = transform

		previewedRef.current.clear()
	}

	// Shows each shape's painted layers in the box it is moving to. A group member is drawn on its group's layers, so
	// only its frame shows where it is going.
	const preview = (boxes: readonly PlacedShape[]): void => {
		if (render === undefined) return

		const elements = layerElements()

		for (const box of boxes) {
			const shape = shapeOf(render, box.id)

			if (shape === undefined || shape.parent !== undefined) continue

			const delta = sameBox(shape.xfrm, box.xfrm) ? undefined : previewMatrix(shape.xfrm, box.xfrm)

			for (const index of shape.layers) {
				const element = elements.get(index)
				const layer = render.layers[index]

				if (element === undefined || layer === undefined || element.style.width === "0px") continue
				if (!previewedRef.current.has(element)) previewedRef.current.set(element, element.style.transform)

				element.style.transform =
					delta === undefined ? (previewedRef.current.get(element) ?? "") : cssMatrix(multiply(delta, layer.matrix))
			}
		}
	}

	const drawFrames = (boxes: readonly PlacedShape[], guides: readonly Guide[], spacing: readonly Spacing[]): void => {
		const paths = framePaths(boxes, scale, editable && boxes.length <= HANDLES_LIMIT)

		outlineRef.current?.setAttribute("d", paths.outline)
		handlesRef.current?.setAttribute("d", paths.handles)
		rotateRef.current?.setAttribute("d", paths.rotate)
		guidesRef.current?.setAttribute("d", guidePath(guides, spacing, scale))
	}

	// The render arrived: follow the slide, keep what it still has, and drop the boxes it now shows.
	useLayoutEffect(() => {
		if (render === undefined) return

		selection.show(render.ref)
		selection.reconcile(render)

		if (expected === undefined) return

		const shown = [...expected].every(([id, xfrm]) => {
			const now = shapeOf(render, id)

			// A member's box comes back through its group's child space, rounded on the way there and back.
			return now === undefined || (now.parent === undefined ? sameBox(now.xfrm, xfrm) : nearBox(now.xfrm, xfrm))
		})

		missesRef.current = shown ? 0 : missesRef.current + 1

		// A render that does not show them yet (an earlier command's) keeps them; two in a row with nothing running
		// mean they will not come (something else changed the slide).
		if (shown || (inflightRef.current === 0 && missesRef.current >= 2)) {
			previewedRef.current.clear()
			setExpected(undefined)

			return
		}

		// SlideView paints this render in its own layout effect, after this one: preview on the new layers then.
		const boxes = [...expected].map(([id, xfrm]) => ({ id, xfrm }))

		queueMicrotask(() => {
			previewedRef.current.clear()
			preview(boxes)
		})
	}, [render])

	// The op's result; undefined for no op.
	const run = async (op: DeckOp | undefined, boxes?: readonly PlacedShape[]): Promise<CommandResult | undefined> => {
		if (op === undefined) {
			restorePreview()

			return undefined
		}

		if (boxes !== undefined) {
			const next = new Map(expected)

			for (const box of boxes) next.set(box.id, box.xfrm)

			setExpected(next)
			preview(boxes)
		}

		inflightRef.current++

		let result: CommandResult

		try {
			result = await command(op)
		} catch {
			result = { ok: false, refusal: "failed" }
		} finally {
			inflightRef.current--
		}

		if (!result.ok && boxes !== undefined) {
			restorePreview()
			setExpected(undefined)
		}

		return result
	}

	// The layer reaches HIT_MARGIN_PX past the slide: points are measured from the slide's own corner.
	const slidePoint = (event: { readonly clientX: number; readonly clientY: number }): Point => {
		const rect = rootRef.current?.getBoundingClientRect()
		const k = scale > 0 ? EMU_PER_PX / scale : EMU_PER_PX

		return { x: (event.clientX - (rect?.left ?? 0) - HIT_MARGIN_PX) * k, y: (event.clientY - (rect?.top ?? 0) - HIT_MARGIN_PX) * k }
	}

	const modifiersOf = (event: {
		readonly shiftKey: boolean
		readonly ctrlKey: boolean
		readonly metaKey: boolean
		readonly altKey: boolean
	}): DragModifiers => ({
		shift: event.shiftKey,
		// On a Mac, Option; a move also copies with Control (PowerPoint's Control+drag), which a press cannot start
		// with (the secondary click) but may hold once the drag runs.
		ctrl: isApple() ? event.altKey || (event.ctrlKey && dragRef.current?.kind === "move") : event.ctrlKey,
		alt: isApple() ? event.metaKey : event.altKey
	})

	// What a drag snaps to besides the guides: the grid, when objects snap to it.
	const snapOf = (others: readonly Bounds[]): NonNullable<ShapeDragOptions["snap"]> =>
		grid?.snap === true ? { others, slide: size, grid } : { others, slide: size }

	// The boxes a drag of `moving` snaps to: every other shape on the slide; for members of a group, their siblings
	// and the shapes outside the group (whose own box follows its members).
	const othersOf = (moving: readonly SlideShape[]): Bounds[] => {
		const ids = new Set(moving.map(shape => shape.id))
		const first = moving[0]
		const outer = first?.parent === undefined ? undefined : outermostOf(render, first).id
		const others: Bounds[] = []

		for (const shape of shapes)
			if (!ids.has(shape.id) && shape.id !== outer) others.push(boundsOf(expected?.get(shape.id) ?? shape.xfrm))

		if (outer !== undefined)
			for (const shape of siblingShapes(render, first))
				if (!ids.has(shape.id)) others.push(boundsOf(expected?.get(shape.id) ?? shape.xfrm))

		return others
	}

	const startDrag = (hit: HandleHit, start: Point): void => {
		if (slide === undefined) return

		const others = othersOf(selected)

		dragRef.current = new ShapeDrag({
			kind: hit.kind,
			slide,
			shapes: placed,
			id: hit.id,
			...(hit.kind === "resize" ? { handle: hit.handle } : {}),
			...(hit.kind === "end" ? { end: hit.end } : {}),
			start,
			snap: snapOf(others),
			threshold: snapThreshold(scale, EMU_PER_PX)
		})
	}

	const flush = (): void => {
		rafRef.current = 0

		const frame = frameRef.current
		const drag = dragRef.current

		if (frame === undefined) return

		if (drag !== undefined) {
			const moved = drag.move(frame.point, frame.modifiers)

			// A copying move keeps the originals painted where they are and draws the copies' boxes.
			if (moved.copy === true) restorePreview()
			else preview(moved.shapes)

			drawFrames(moved.shapes, moved.guides, moved.spacing)

			return
		}

		const pending = pendingRef.current
		const rect = marqueeRef.current

		if (pending?.kind === "marquee" && rect !== null) {
			const x = Math.min(pending.screen.x, frame.screen.x)
			const y = Math.min(pending.screen.y, frame.screen.y)

			rect.setAttribute("x", String(x))
			rect.setAttribute("y", String(y))
			rect.setAttribute("width", String(Math.abs(frame.screen.x - pending.screen.x)))
			rect.setAttribute("height", String(Math.abs(frame.screen.y - pending.screen.y)))
			rect.style.display = ""
		}
	}

	const schedule = (): void => {
		if (rafRef.current === 0) rafRef.current = requestAnimationFrame(flush)
	}

	const screenPoint = (event: { readonly clientX: number; readonly clientY: number }): Point => {
		const rect = rootRef.current?.getBoundingClientRect()

		return { x: event.clientX - (rect?.left ?? 0) - HIT_MARGIN_PX, y: event.clientY - (rect?.top ?? 0) - HIT_MARGIN_PX }
	}

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (pointerRef.current !== undefined && pointerRef.current !== event.pointerId) {
			// A second pointer while one drags: ignored, and kept from scrolling or zooming the page.
			event.preventDefault()

			return
		}

		// Control+click on a Mac is the secondary click: the context menu's (onContextMenu), not an additive press.
		if (event.button !== 0 || (event.ctrlKey && event.pointerType === "mouse" && isApple()) || slide === undefined) return

		const root = rootRef.current

		pointerRef.current = event.pointerId
		root?.focus({ preventScroll: true })
		root?.setPointerCapture(event.pointerId)
		event.preventDefault()

		const point = slidePoint(event)
		const screen = screenPoint(event)
		const additive = event.shiftKey || event.ctrlKey || event.metaKey

		// A finger covers more than a pointer: handles grab from twice as far.
		const grab = (event.pointerType === "touch" ? 2 : 1) * HANDLE_GRAB_PX * emuPerScreenPx

		// Handles first, whatever the modifiers: Shift on a corner keeps the proportions, Ctrl resizes from the centre.
		if (editable && placed.length <= HANDLES_LIMIT) {
			const hit = handleAt(placed, point, grab, ROTATE_OFFSET_PX * emuPerScreenPx, emuPerScreenPx)

			if (hit !== undefined) {
				startDrag(hit, point)
				frameRef.current = { point, modifiers: modifiersOf(event), screen }

				return
			}
		}

		const target = clickTarget(render, state.ids, point, grab * 0.5)
		const shape = target?.shape
		const before = state.ids

		if (shape === undefined) {
			if (!additive) selection.clear()

			pendingRef.current = { start: point, screen, kind: "marquee", additive, before }

			return
		}

		// A modifier press adds the shape at once (a drag then moves it with the rest); one already selected leaves
		// the selection only on a release without a drag, so Shift held from the start constrains a move. Only shapes
		// of one level are selected together: a shape at another one replaces the selection.
		const deselect = additive && state.ids.includes(shape.id) ? shape.id : undefined
		const sameLevel = before.length === 0 || shapeOf(render, before[0] ?? -1)?.parent === shape.parent

		if (additive && deselect === undefined) selection.set(sameLevel ? [...state.ids, shape.id] : [shape.id])
		else if (!additive && !state.ids.includes(shape.id)) selection.set([shape.id])

		// A click on a selected group goes into it on release (its press still drags the group).
		const into = additive ? undefined : target?.into
		const intoEnters =
			into !== undefined && editable && onEnterText !== undefined && clickEntersText(into) && event.pointerType !== "touch"

		// A plain click on a text placeholder, text box or table puts the caret there, unless it lands in a selection of
		// several (it keeps that selection); a finger's first tap only selects (a second one enters).
		const enter =
			!additive &&
			editable &&
			onEnterText !== undefined &&
			clickEntersText(shape) &&
			!(before.length > 1 && before.includes(shape.id)) &&
			(event.pointerType !== "touch" || before.includes(shape.id))
				? shape.id
				: undefined

		pendingRef.current = {
			start: point,
			screen,
			kind: "move",
			additive,
			before,
			...(deselect === undefined ? {} : { deselect }),
			...(enter === undefined ? {} : { enter }),
			...(into === undefined ? {} : { into: into.id, ...(intoEnters ? { intoEnters } : {}) })
		}
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		if (pointerRef.current !== undefined && pointerRef.current !== event.pointerId) return

		const point = slidePoint(event)
		const screen = screenPoint(event)
		const pending = pendingRef.current

		if (dragRef.current === undefined && pending === undefined) {
			// Hover: the cursor a press here would get.
			const root = rootRef.current

			if (root === null) return

			const hit =
				editable && placed.length <= HANDLES_LIMIT
					? handleAt(placed, point, HANDLE_GRAB_PX * emuPerScreenPx, ROTATE_OFFSET_PX * emuPerScreenPx, emuPerScreenPx)
					: undefined
			const over =
				hit === undefined ? hitPath(render, point, HANDLE_GRAB_PX * emuPerScreenPx * 0.5, new Set(state.ids))[0] : undefined
			const box = hit === undefined ? undefined : placed.find(shape => shape.id === hit.id)?.xfrm

			root.style.cursor =
				hit?.kind === "rotate"
					? "grab"
					: hit?.kind === "end"
						? "crosshair"
						: hit !== undefined && box !== undefined
							? handleCursor(box, hit.handle)
							: over !== undefined && editable
								? "move"
								: ""

			return
		}

		if (pending !== undefined && dragRef.current === undefined) {
			if (Math.hypot(screen.x - pending.screen.x, screen.y - pending.screen.y) < DRAG_START_PX) return

			if (pending.kind === "move") {
				if (!editable || selection.getSnapshot().ids.length === 0) {
					pendingRef.current = undefined

					return
				}

				// The selection as it is after the press (the pressed shape added).
				pendingRef.current = undefined
				startDragFromSelection(pending.start)
			}
		}

		frameRef.current = { point, modifiers: modifiersOf(event), screen }
		schedule()
	}

	// A move drag starts from the selection the press left (React has not rendered it yet).
	const startDragFromSelection = (start: Point): void => {
		if (slide === undefined || render === undefined) return

		const chosen = selectedShapes(render, selection.getSnapshot())
		const now = chosen.map(shape => placedOf(shape, expected))
		const others = othersOf(chosen)

		dragRef.current = new ShapeDrag({
			kind: "move",
			slide,
			shapes: now,
			start,
			snap: snapOf(others),
			threshold: snapThreshold(scale, EMU_PER_PX)
		})
	}

	// Ends the press or drag the layer follows (its pointer's capture, the frame waiting to be drawn, the guides, the
	// marquee); what it was is the caller's to finish or drop.
	const endPointer = (): void => {
		const pointer = pointerRef.current
		const root = rootRef.current

		pointerRef.current = undefined
		dragRef.current = undefined
		pendingRef.current = undefined
		frameRef.current = undefined

		if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current)

		rafRef.current = 0
		guidesRef.current?.setAttribute("d", "")

		if (marqueeRef.current !== null) marqueeRef.current.style.display = "none"
		if (pointer !== undefined && root?.hasPointerCapture(pointer) === true) root.releasePointerCapture(pointer)
	}

	// An op that makes shapes (group, ungroup, duplicate, a Ctrl+drag's copies) selects what it makes, at any level
	// (inside a group too); refused, the request is withdrawn and the selection is what it was (unless something
	// replaced the request meanwhile).
	const runSelectingNew = (op: DeckOp | undefined): boolean => {
		if (op === undefined || slide === undefined) return false

		const withdraw = selection.selectNew(slide, { placements: placements(render) })

		void run(op).then(result => {
			if (result?.ok !== true) withdraw()
		})

		return true
	}

	const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
		if (pointerRef.current !== event.pointerId) return

		const drag = dragRef.current
		const pending = pendingRef.current
		const last = frameRef.current

		endPointer()

		if (drag !== undefined) {
			if (cancelled || last === undefined) {
				restorePreview()
				drawFrames(placed, [], [])

				return
			}

			const moved = drag.move(slidePoint(event), modifiersOf(event))

			if (moved.copy === true) {
				// The originals stay; the copies become the selection once the render shows them.
				drawFrames(placed, [], [])
				runSelectingNew(drag.end())

				return
			}

			void run(drag.end(), moved.shapes)

			return
		}

		// A modifier click on a selected shape, released without a drag: it leaves the selection.
		if (pending?.kind === "move" && pending.deselect !== undefined && !cancelled) selection.toggle(pending.deselect)

		// A click on a selected group, released without a drag: the member under it is selected (a text box's or
		// placeholder's body opens where the click landed).
		if (pending?.kind === "move" && pending.into !== undefined && !cancelled && slide !== undefined) {
			selection.set([pending.into])

			if (pending.intoEnters === true)
				onEnterText?.({ slide, id: pending.into }, { x: pending.start.x / EMU_PER_PX, y: pending.start.y / EMU_PER_PX })
		}

		// A plain click on a text placeholder, text box or table, released without a drag: the caret goes where it landed.
		if (pending?.kind === "move" && pending.enter !== undefined && !cancelled && slide !== undefined)
			onEnterText?.({ slide, id: pending.enter }, { x: pending.start.x / EMU_PER_PX, y: pending.start.y / EMU_PER_PX })

		if (pending?.kind === "marquee" && !cancelled) {
			const end = slidePoint(event)
			const area = {
				x: Math.min(pending.start.x, end.x),
				y: Math.min(pending.start.y, end.y),
				r: Math.max(pending.start.x, end.x),
				b: Math.max(pending.start.y, end.y)
			}
			const inside = shapesInside(shapes, area)

			if (inside.length > 0 || !pending.additive) selection.set(pending.additive ? [...pending.before, ...inside] : inside)
		}
	}

	const objectCommand = (name: ObjectCommand | "duplicate"): boolean => {
		if (slide === undefined) return false

		const ids = placed.map(shape => shape.id)

		// Inside a group, Select All selects the group's members (PowerPoint).
		if (name === "selectAll") {
			selection.set(level.filter(selectable).map(shape => shape.id))

			return true
		}

		if (!editable || ids.length === 0) return false

		// Ungroup: every selected group in one op (one undo step). Inside a group, members group into a group of their
		// own there, and a member group ungroups into its group.
		if (name === "group") return canGroup(selected) && runSelectingNew(groupOp(slide, ids))
		if (name === "ungroup") return runSelectingNew(ungroupOps(slide, selected)[0])

		if (name === "duplicate") {
			// The copies stack as the originals do (back to front), in their group for members, and become the selection.
			const chosen = new Set(ids)

			return runSelectingNew(
				duplicateOp(
					slide,
					level.filter(shape => chosen.has(shape.id)).map(shape => shape.id),
					undefined,
					undefined,
					selected[0]?.space
				)
			)
		}

		const to = Z_ORDER_OF[name]

		// Members move among their siblings.
		if (
			to === undefined ||
			!canZOrder(
				level.map(shape => shape.id),
				new Set(ids),
				to
			)
		)
			return false

		void run(zOrderOp(slide, ids, to))

		return true
	}

	// A body's formatting key (Mod+B, Mod+E…) on shapes selected as objects formats their whole text, as the ribbon
	// does, in one op (one undo step). Presses in a row apply in order, each on what the one before made.
	const formatSelection = (event: KeyboardEvent<HTMLDivElement>): boolean => {
		if (text === undefined || !editable || slide === undefined) return false

		const apple = isApple()
		const key = textKeyCommand(event, text.bindings ?? defaultTextBindings(apple), apple)
		const format = key === undefined ? undefined : formatKey(key)
		const targets = selected.filter(oneBody).map(shape => ({ slide, id: shape.id }))

		if (format === undefined || targets.length === 0) return false

		const session = text.session

		formattingRef.current = formattingRef.current.then(async () => {
			const op = await formatShapesOp(session, targets, format)

			if (op !== undefined) await run(op)
		})

		return true
	}

	// A modifier pressed or released during a drag: the frame waiting to be drawn takes it.
	const dragModifierKey = (event: KeyboardEvent<HTMLDivElement>): boolean => {
		const frame = frameRef.current

		if (dragRef.current === undefined || frame === undefined || !MODIFIER_KEYS.has(event.key)) return false

		frameRef.current = { ...frame, modifiers: modifiersOf(event) }
		schedule()

		return true
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (slide === undefined || dragModifierKey(event)) return

		const action = objectKeyAction(event, bindings, isApple())

		if (action === undefined) {
			if (formatSelection(event)) event.preventDefault()

			return
		}

		switch (action.kind) {
			case "command":
				if (objectCommand(action.command)) event.preventDefault()

				return
			case "duplicate":
				if (objectCommand("duplicate")) event.preventDefault()

				return
			case "escape":
				if (dragRef.current !== undefined || pendingRef.current !== undefined) {
					endPointer()
					restorePreview()
					drawFrames(placed, [], [])
				} else if (group !== undefined) {
					// Out of the group: the group is selected again (PowerPoint), one level per press.
					selection.set([group.id])
				} else if (state.ids.length > 0) {
					selection.clear()
				} else {
					return
				}

				event.preventDefault()

				return
			case "cycle": {
				// Inside a group, Tab goes round its members.
				const next = cycleTarget(
					level.filter(selectable).map(shape => shape.id),
					state.ids,
					action.back
				)

				if (next === undefined) return

				selection.set([next])
				event.preventDefault()

				return
			}
			case "enter": {
				const only = selected.length === 1 ? selected[0] : undefined

				if (only === undefined || !holdsText(only) || onEnterText === undefined || !editable) return

				onEnterText({ slide, id: only.id }, undefined, action.selectAll ? { selectAll: true } : undefined)
				event.preventDefault()

				return
			}
			case "type": {
				// The character opens the body (the caret at the end of its text, nothing replaced) and is typed there.
				const only = selected.length === 1 ? selected[0] : undefined

				if (only === undefined || !oneBody(only) || onEnterText === undefined || text === undefined || !editable) return
				// An input method's key: its composition is typed once the body is open, never as this key.
				if (event.nativeEvent.isComposing || event.keyCode === 229) return

				event.preventDefault()
				text.editing.expect({ typed: action.text })
				onEnterText({ slide, id: only.id })

				return
			}
			case "delete":
				if (!editable || placed.length === 0) return

				event.preventDefault()
				selection.clear()
				void run(
					deleteOp(
						slide,
						placed.map(shape => shape.id)
					)
				)

				return
			case "nudge": {
				if (!editable || placed.length === 0) return

				event.preventDefault()

				const op = nudgeOp(slide, placed, action.direction, action.large)

				if (op === undefined) return

				const step = (action.large ? 10 : 1) * EMU_PER_PX
				const dx = action.direction === "left" ? -step : action.direction === "right" ? step : 0
				const dy = action.direction === "up" ? -step : action.direction === "down" ? step : 0

				void run(
					op,
					placed.map(shape =>
						canMove(shape)
							? { ...shape, xfrm: { ...shape.xfrm, x: Math.round(shape.xfrm.x + dx), y: Math.round(shape.xfrm.y + dy) } }
							: shape
					)
				)

				return
			}
			case "resize":
			case "rotate": {
				if (!editable || placed.length === 0) return

				event.preventDefault()

				const boxes =
					action.kind === "resize"
						? steppedShapes(placed, action.direction)
						: turnedShapes(placed, action.clockwise ? ROTATE_SNAP : -ROTATE_SNAP)
				const op = xfrmsOp(slide, placed, boxes)

				if (op !== undefined) void run(op, boxes)

				return
			}
		}
	}

	// A secondary click selects what the menu will act on, as PowerPoint: a shape outside the selection becomes the
	// selection, one inside it (or a handle of it) keeps it, empty slide clears it. The menu itself is the host's.
	const onContextMenu = (event: { readonly clientX: number; readonly clientY: number }): void => {
		if (slide === undefined || dragRef.current !== undefined) return

		const point = slidePoint(event)
		const ids = selection.getSnapshot().ids
		// A selected group keeps its selection under the click (its menu, not its member's).
		const shape = clickTarget(render, ids, point, HANDLE_GRAB_PX * emuPerScreenPx * 0.5)?.shape

		if (shape !== undefined) {
			if (!ids.includes(shape.id)) selection.set([shape.id])

			return
		}

		const onHandle =
			editable &&
			placed.length <= HANDLES_LIMIT &&
			handleAt(placed, point, HANDLE_GRAB_PX * emuPerScreenPx, ROTATE_OFFSET_PX * emuPerScreenPx, emuPerScreenPx) !== undefined

		if (!onHandle && ids.length > 0) selection.clear()
	}

	const onDoubleClick = (event: { readonly clientX: number; readonly clientY: number }): void => {
		if (!editable || slide === undefined || onEnterText === undefined) return

		const point = slidePoint(event)
		// The innermost shape under it: a double click on a grouped shape's text edits that text (PowerPoint).
		const path = hitPath(render, point, HANDLE_GRAB_PX * emuPerScreenPx * 0.5, new Set(selection.getSnapshot().ids))
		const shape = path[path.length - 1]

		if (shape === undefined || !holdsText(shape)) return
		if (shape.parent !== undefined && !selection.getSnapshot().ids.includes(shape.id)) selection.set([shape.id])

		onEnterText({ slide, id: shape.id }, { x: point.x / EMU_PER_PX, y: point.y / EMU_PER_PX })
	}

	const paths = framePaths(placed, scale, editable && placed.length <= HANDLES_LIMIT)
	// The group whose members are selected, framed dashed (its box as an op left it until the render shows it).
	const groupOutline =
		group === undefined ? "" : framePaths([{ id: group.id, xfrm: expected?.get(group.id) ?? group.xfrm }], scale, false).outline
	const announcement = labels.describe(selected)
	const keysId = useId()

	return (
		<div
			ref={rootRef}
			className="fo-shape-edit"
			data-fo-shape-edit=""
			role="application"
			aria-label={labels.canvas}
			aria-describedby={labels.keys === undefined ? undefined : keysId}
			tabIndex={0}
			style={{ position: "absolute", inset: -HIT_MARGIN_PX, touchAction: "none", outline: "none" }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={event => {
				finish(event, false)
			}}
			onPointerCancel={event => {
				finish(event, true)
			}}
			onLostPointerCapture={event => {
				if (dragRef.current !== undefined || pendingRef.current !== undefined) finish(event, true)
			}}
			onKeyDown={onKeyDown}
			onKeyUp={event => {
				dragModifierKey(event)
			}}
			onContextMenu={onContextMenu}
			onDoubleClick={onDoubleClick}
		>
			<svg
				aria-hidden="true"
				style={{
					position: "absolute",
					left: HIT_MARGIN_PX,
					top: HIT_MARGIN_PX,
					width: `calc(100% - ${String(2 * HIT_MARGIN_PX)}px)`,
					height: `calc(100% - ${String(2 * HIT_MARGIN_PX)}px)`,
					overflow: "visible",
					pointerEvents: "none"
				}}
			>
				<path
					ref={guidesRef}
					fill="none"
					stroke={GUIDE}
					strokeWidth={1}
					d=""
				/>
				<path
					ref={outlineRef}
					fill="none"
					stroke={FRAME}
					strokeWidth={1}
					d={paths.outline}
				/>
				<path
					ref={rotateRef}
					fill="var(--fo-handle, #fff)"
					stroke={FRAME}
					strokeWidth={1}
					d={paths.rotate}
				/>
				<path
					ref={handlesRef}
					fill="var(--fo-handle, #fff)"
					stroke={FRAME}
					strokeWidth={1}
					d={paths.handles}
				/>
				<path
					data-fo-group-frame=""
					fill="none"
					stroke={FRAME}
					strokeWidth={1}
					strokeDasharray="4 3"
					d={groupOutline}
				/>
				<rect
					ref={marqueeRef}
					fill="var(--fo-marquee, rgb(37 99 235 / 0.08))"
					stroke={FRAME}
					strokeWidth={1}
					strokeDasharray="4 2"
					style={{ display: "none" }}
				/>
			</svg>
			{labels.keys === undefined ? null : (
				<div
					id={keysId}
					hidden
				>
					{labels.keys}
				</div>
			)}
			<div
				aria-live="polite"
				style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}
			>
				{announcement}
			</div>
		</div>
	)
}
