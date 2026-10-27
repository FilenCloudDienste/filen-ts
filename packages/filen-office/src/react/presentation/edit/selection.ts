import { useSyncExternalStore } from "react"
import type { Action, LockReason, ShapeLocks, ShapeNode, SlideRef, Xfrm } from "../../../core/presentation/model"
import type { LayerRole, SlideRender } from "../../../core/presentation/output"

// The editor's shape selection: which top-level shapes of the slide in view are selected, as an external store
// the canvas overlay, the ribbon and the keyboard share. The shapes themselves come from the slide's render (each
// layer of the slide's own shapes carries its box), so selecting, hit testing and the marquee never ask the worker.

// A top-level shape of the slide in view: its box (EMU), what it is, and the layers that paint it.
export interface SlideShape {
	readonly id: number
	readonly xfrm: Xfrm
	readonly role: LayerRole
	// Indices into render.layers, back to front.
	readonly layers: readonly number[]
	readonly alt?: ShapeNode["alt"]
	readonly actions?: { readonly click?: Action; readonly hover?: Action }
	readonly lock?: LockReason
	// The file's own locks (selection, move, resize, turn, aspect, grouping).
	readonly locks?: ShapeLocks
	// Drawn as a line between two ends (a connector or a line preset).
	readonly line?: true
}

// Whether a click, the marquee, Tab or Select All may select the shape: not one the file locks against selection
// (noSelect, as PowerPoint leaves such shapes to its Selection Pane).
export function selectable(shape: SlideShape): boolean {
	return shape.locks?.noSelect !== true
}

// Axis-aligned bounds of a box as it shows (its corners turned by rot about its centre), EMU.
export interface Bounds {
	readonly x: number
	readonly y: number
	readonly r: number
	readonly b: number
}

const shapesOfRender = new WeakMap<SlideRender, readonly SlideShape[]>()

// The slide's own top-level shapes, back to front (the order their first layers paint in). Kept per render.
export function slideShapes(render: SlideRender | undefined): readonly SlideShape[] {
	if (render === undefined) return []

	const known = shapesOfRender.get(render)

	if (known !== undefined) return known

	const byId = new Map<number, { shape: SlideShape; layers: number[] }>()
	const out: { shape: SlideShape; layers: number[] }[] = []

	render.layers.forEach((layer, index) => {
		const box = layer.box

		if (box === undefined) return

		const seen = byId.get(box.id)

		if (seen !== undefined) {
			seen.layers.push(index)

			return
		}

		const layers = [index]
		// A group's layers name its role "group" on its own layers; a child frame's overlay keeps the group's.
		const shape: SlideShape = {
			id: box.id,
			xfrm: box.xfrm,
			role: layer.shape.id === box.id ? layer.role : "group",
			layers,
			...(box.alt === undefined ? {} : { alt: box.alt }),
			...(box.locks === undefined ? {} : { locks: box.locks }),
			...(box.line === true ? { line: true as const } : {}),
			...(layer.actions === undefined || layer.shape.id !== box.id ? {} : { actions: layer.actions }),
			...(layer.lock === undefined || layer.shape.id !== box.id ? {} : { lock: layer.lock })
		}
		const entry = { shape, layers }

		byId.set(box.id, entry)
		out.push(entry)
	})

	const shapes = out.map(entry => entry.shape)

	shapesOfRender.set(render, shapes)

	return shapes
}

export function boundsOf(xfrm: Xfrm): Bounds {
	if (xfrm.rot === 0) return { x: xfrm.x, y: xfrm.y, r: xfrm.x + xfrm.cx, b: xfrm.y + xfrm.cy }

	// Quarter turns exactly (their bounds are what edges snap to), any other turn by its corners.
	const quarter = xfrm.rot % 5_400_000 === 0
	const swapped = quarter && xfrm.rot % 10_800_000 !== 0
	const angle = (xfrm.rot / 60000 / 180) * Math.PI
	const cos = quarter ? (swapped ? 0 : 1) : Math.abs(Math.cos(angle))
	const sin = quarter ? (swapped ? 1 : 0) : Math.abs(Math.sin(angle))
	const w = xfrm.cx * cos + xfrm.cy * sin
	const h = xfrm.cx * sin + xfrm.cy * cos
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2

	return { x: cx - w / 2, y: cy - h / 2, r: cx + w / 2, b: cy + h / 2 }
}

export function unionBounds(items: readonly Bounds[]): Bounds | undefined {
	if (items.length === 0) return undefined

	let x = Infinity
	let y = Infinity
	let r = -Infinity
	let b = -Infinity

	for (const item of items) {
		if (item.x < x) x = item.x
		if (item.y < y) y = item.y
		if (item.r > r) r = item.r
		if (item.b > b) b = item.b
	}

	return { x, y, r, b }
}

// Whether slide point (px, py) lies on the shape's box as it shows, within `slack` EMU (so a line, whose box has
// no height, is still hit near it).
export function onShape(xfrm: Xfrm, px: number, py: number, slack: number): boolean {
	const cx = xfrm.x + xfrm.cx / 2
	const cy = xfrm.y + xfrm.cy / 2
	let dx = px - cx
	let dy = py - cy

	if (xfrm.rot !== 0) {
		const angle = (-xfrm.rot / 60000 / 180) * Math.PI
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		const turned = dx * cos - dy * sin

		dy = dx * sin + dy * cos
		dx = turned
	}

	return Math.abs(dx) <= xfrm.cx / 2 + slack && Math.abs(dy) <= xfrm.cy / 2 + slack
}

// The front-most selectable shape at a slide point.
export function shapeAt(
	shapes: readonly SlideShape[],
	point: { readonly x: number; readonly y: number },
	slack: number
): SlideShape | undefined {
	for (let k = shapes.length - 1; k >= 0; k--) {
		const shape = shapes[k] as SlideShape

		if (selectable(shape) && onShape(shape.xfrm, point.x, point.y, slack)) return shape
	}

	return undefined
}

// The selectable shapes a marquee holds whole (PowerPoint's rule), back to front.
export function shapesInside(shapes: readonly SlideShape[], area: Bounds): number[] {
	const out: number[] = []

	for (const shape of shapes) {
		if (!selectable(shape)) continue

		const box = boundsOf(shape.xfrm)

		if (box.x >= area.x && box.r <= area.r && box.y >= area.y && box.b <= area.b) out.push(shape.id)
	}

	return out
}

// ---- the store ----------------------------------------------------------------------------------------------

export interface ShapeSelectionState {
	readonly slide: SlideRef | undefined
	// Top-level shape ids, in the order they were selected (the first is the one Tab moves on from).
	readonly ids: readonly number[]
	// A command that adds or removes top-level shapes (group, ungroup) asked to select what the next render of
	// this slide has that `before` did not.
	readonly pending?: { readonly slide: SlideRef; readonly before: ReadonlySet<number> }
}

export interface ShapeSelection {
	getSnapshot(): ShapeSelectionState
	subscribe(listener: () => void): () => void
	// The slide in view: another slide clears the selection.
	show(slide: SlideRef | undefined): void
	set(ids: readonly number[]): void
	toggle(id: number): void
	clear(): void
	// After a command on `slide`, select the top-level shapes the next render has beyond `before`.
	selectNew(slide: SlideRef, before: Iterable<number>): void
	// The render of the slide in view arrived: keep only ids it still has, resolve a pending selectNew.
	reconcile(render: SlideRender): void
}

const EMPTY: ShapeSelectionState = { slide: undefined, ids: [] }

export function createShapeSelection(): ShapeSelection {
	let state = EMPTY
	const listeners = new Set<() => void>()
	const commit = (next: ShapeSelectionState): void => {
		if (next === state) return

		state = next

		for (const listener of listeners) listener()
	}
	const sameIds = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((id, k) => id === b[k])

	return {
		getSnapshot: () => state,
		subscribe: listener => {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		show: slide => {
			if (slide !== state.slide) commit({ slide, ids: [] })
		},
		set: ids => {
			const unique = [...new Set(ids)]

			if (!sameIds(unique, state.ids) || state.pending !== undefined) commit({ slide: state.slide, ids: unique })
		},
		toggle: id => {
			commit({ slide: state.slide, ids: state.ids.includes(id) ? state.ids.filter(other => other !== id) : [...state.ids, id] })
		},
		clear: () => {
			if (state.ids.length > 0 || state.pending !== undefined) commit({ slide: state.slide, ids: [] })
		},
		selectNew: (slide, before) => {
			commit({ slide: state.slide, ids: state.ids, pending: { slide, before: new Set(before) } })
		},
		reconcile: render => {
			if (render.ref !== state.slide) return

			const shapes = slideShapes(render)
			const pending = state.pending

			if (pending !== undefined && pending.slide === render.ref) {
				const fresh = shapes.filter(shape => !pending.before.has(shape.id)).map(shape => shape.id)

				// The command's render may not be this one yet (an older render arriving first changes nothing).
				if (fresh.length > 0) commit({ slide: state.slide, ids: fresh })

				return
			}

			const present = new Set(shapes.map(shape => shape.id))
			const kept = state.ids.filter(id => present.has(id))

			if (kept.length !== state.ids.length) commit({ slide: state.slide, ids: kept })
		}
	}
}

export function useShapeSelection(store: ShapeSelection): ShapeSelectionState {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

// The selected shapes in back-to-front order.
export function selectedShapes(render: SlideRender | undefined, state: ShapeSelectionState): SlideShape[] {
	if (render === undefined || render.ref !== state.slide || state.ids.length === 0) return []

	const ids = new Set(state.ids)

	return slideShapes(render).filter(shape => ids.has(shape.id))
}

// What the selection holds, for the ribbon's contextual tabs.
export type SelectionKind = "shape" | "picture" | "table" | "chart" | "smartart"

export function selectionKinds(shapes: readonly SlideShape[]): ReadonlySet<SelectionKind> {
	const kinds = new Set<SelectionKind>()

	for (const shape of shapes) {
		switch (shape.role) {
			case "picture":
			case "table":
			case "chart":
			case "smartart":
				kinds.add(shape.role)
				break
			case "shape":
			case "placeholder":
			case "group":
			case "ink":
				kinds.add("shape")
				break
			default:
				break
		}
	}

	return kinds
}
