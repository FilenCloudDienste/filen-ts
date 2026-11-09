import { useSyncExternalStore } from "react"
import type { Action, LockReason, ShapeLocks, ShapeNode, SlideRef, Xfrm } from "../../../core/presentation/model"
import { ownThrough } from "../../../core/presentation/groupSpace"
import type { GroupMember, LayerRole, ShapeBodyKind, SlideMediaInfo, SlideRender } from "../../../core/presentation/output"

// The editor's shape selection: which shapes of the slide in view are selected (top-level shapes, or members of one
// group), as an external store the canvas overlay, the ribbon and the keyboard share. The shapes themselves come from
// the slide's render (each layer of the slide's own shapes carries its box, a group's its members'), so selecting,
// hit testing and the marquee never ask the worker.

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
	// What the shape plays, when it is a medium (the Video and Audio tabs).
	readonly media?: SlideMediaInfo
	// Drawn as a line between two ends (a connector or a line preset).
	readonly line?: true
	// A line's stroke when it is not the segment between its ends (the render box's path).
	readonly path?: readonly number[]
	// The text body it holds (none: a picture, a group, a chart, a connector).
	readonly body?: ShapeBodyKind
	// The roles of the layers that paint it and of the frames and media its members hold (what flipping it would mirror).
	readonly roles?: readonly LayerRole[]
	// A group member's (selected inside its group, as PowerPoint's second click does): the group it is in, and the
	// own boxes of its enclosing groups, outermost first, which a box it is given on the slide goes back through
	// (ownXfrm). Its `xfrm` is its box as it shows on the slide; its `layers` the ones that draw its text or frame on
	// their own (the rest of it is on its group's).
	readonly parent?: number
	readonly space?: readonly Xfrm[]
}

// Whether a click, the marquee, Tab or Select All may select the shape: not one the file locks against selection
// (noSelect, as PowerPoint leaves such shapes to its Selection Pane), nor a master's field the slide shows (as
// LibreOffice leaves those to master view: no edit of the slide can change them).
export function selectable(shape: SlideShape): boolean {
	return shape.locks?.noSelect !== true && shape.lock !== "master"
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

	const byId = new Map<number, { shape: SlideShape; layers: number[]; roles: LayerRole[] }>()
	const out: { shape: SlideShape; layers: number[]; roles: LayerRole[] }[] = []

	render.layers.forEach((layer, index) => {
		const box = layer.box

		if (box === undefined) return

		const seen = byId.get(box.id)

		if (seen !== undefined) {
			seen.layers.push(index)
			seen.roles.push(layer.role)
			for (const role of layer.holds ?? []) seen.roles.push(role)

			return
		}

		const layers = [index]
		const roles: LayerRole[] = [layer.role, ...(layer.holds ?? [])]
		// A group's layers name its role "group" on its own layers; a child frame's overlay keeps the group's.
		const shape: SlideShape = {
			id: box.id,
			xfrm: box.xfrm,
			role: layer.shape.id === box.id ? layer.role : "group",
			layers,
			...(box.alt === undefined ? {} : { alt: box.alt }),
			...(box.locks === undefined ? {} : { locks: box.locks }),
			...(box.line === true ? { line: true as const } : {}),
			...(box.line === true && box.path !== undefined ? { path: box.path } : {}),
			...(box.body === undefined ? {} : { body: box.body }),
			...(layer.actions === undefined || layer.shape.id !== box.id ? {} : { actions: layer.actions }),
			...(layer.lock === undefined || layer.shape.id !== box.id ? {} : { lock: layer.lock }),
			...(layer.media === undefined || layer.shape.id !== box.id ? {} : { media: layer.media }),
			roles
		}
		const entry = { shape, layers, roles }

		byId.set(box.id, entry)
		out.push(entry)
	})

	const shapes = out.map(entry => entry.shape)

	shapesOfRender.set(render, shapes)

	return shapes
}

// ---- group members ------------------------------------------------------------------------------------------

interface ShapeIndex {
	// Every shape of the slide by id, members however deep included.
	readonly byId: ReadonlyMap<number, SlideShape>
	// A group's members, back to front, by the group's id.
	readonly members: ReadonlyMap<number, readonly SlideShape[]>
}

const indexOfRender = new WeakMap<SlideRender, ShapeIndex>()

// The roles a member and everything it holds draw with (what flipping it would mirror).
function memberRoles(member: GroupMember, into: LayerRole[]): LayerRole[] {
	into.push(member.role)

	if (member.media !== undefined) into.push("media")

	for (const inner of member.members ?? []) memberRoles(inner, into)

	return into
}

// Built once per render, on the first ask (a slide without groups only indexes its top-level shapes).
function shapeIndex(render: SlideRender): ShapeIndex {
	const known = indexOfRender.get(render)

	if (known !== undefined) return known

	const byId = new Map<number, SlideShape>()
	const members = new Map<number, readonly SlideShape[]>()
	const top = slideShapes(render)
	let layersOf: Map<number, number[]> | undefined

	// The layers that draw a member's text or frame on their own, named by the member.
	const ownLayers = (id: number): readonly number[] => {
		if (layersOf === undefined) {
			const built = new Map<number, number[]>()

			render.layers.forEach((layer, index) => {
				if (layer.box === undefined || layer.shape.id === layer.box.id) return

				const list = built.get(layer.shape.id)

				if (list === undefined) built.set(layer.shape.id, [index])
				else list.push(index)
			})
			layersOf = built
		}

		return layersOf.get(id) ?? []
	}
	const add = (list: readonly GroupMember[], parent: number, space: readonly Xfrm[], depth: number): void => {
		const out: SlideShape[] = []

		for (const member of list) {
			const shape: SlideShape = {
				id: member.id,
				xfrm: member.xfrm,
				role: member.role,
				layers: ownLayers(member.id),
				...(member.alt === undefined ? {} : { alt: member.alt }),
				...(member.lock === undefined ? {} : { lock: member.lock }),
				...(member.locks === undefined ? {} : { locks: member.locks }),
				...(member.media === undefined ? {} : { media: member.media }),
				...(member.line === true ? { line: true as const } : {}),
				...(member.body === undefined ? {} : { body: member.body }),
				roles: member.members === undefined && member.media === undefined ? [member.role] : memberRoles(member, []),
				parent,
				space
			}

			if (!byId.has(shape.id)) byId.set(shape.id, shape)

			out.push(shape)

			if (member.members !== undefined && depth < 128) add(member.members, member.id, [...space, member.own], depth + 1)
		}

		members.set(parent, out)
	}

	for (const shape of top) if (!byId.has(shape.id)) byId.set(shape.id, shape)

	for (const shape of top) {
		const box = render.layers[shape.layers[0] ?? -1]?.box

		if (box?.members !== undefined) add(box.members, shape.id, [box.xfrm], 0)
	}

	const index = { byId, members }

	indexOfRender.set(render, index)

	return index
}

// The slide's shape with this id, a group's member however deep included.
export function shapeOf(render: SlideRender | undefined, id: number): SlideShape | undefined {
	return render === undefined ? undefined : shapeIndex(render).byId.get(id)
}

// A group's shown members, back to front; none for a shape that is no group.
export function groupMembers(render: SlideRender | undefined, group: number): readonly SlideShape[] {
	return render === undefined ? [] : (shapeIndex(render).members.get(group) ?? [])
}

// The shapes at a shape's own level, back to front: its group's members, or the slide's top-level shapes.
export function siblingShapes(render: SlideRender | undefined, shape: SlideShape | undefined): readonly SlideShape[] {
	return shape?.parent === undefined ? slideShapes(render) : groupMembers(render, shape.parent)
}

// The box a shape takes in its own terms (its group's child space for a member) for a box `shown` on the slide.
export function ownXfrm(shape: { readonly space?: readonly Xfrm[] }, shown: Xfrm): Xfrm {
	return shape.space === undefined || shape.space.length === 0 ? shown : ownThrough(shape.space, shown)
}

// Whether a press at the point lands on the shape: a group on one of its members (however deep; a press on the empty
// space between them goes through to what lies behind, as in PowerPoint), or on its box once it is selected (so it
// is dragged from anywhere in its frame); any other shape on its box, a line near its stroke.
function hitsDeep(index: ShapeIndex, shape: SlideShape, px: number, py: number, slack: number, selected: ReadonlySet<number>): boolean {
	const members = index.members.get(shape.id)

	if (members === undefined || members.length === 0) return hitsShape(shape, px, py, slack)
	if (selected.has(shape.id) && onShape(shape.xfrm, px, py, slack)) return true

	for (let k = members.length - 1; k >= 0; k--) if (hitsDeep(index, members[k] as SlideShape, px, py, slack, selected)) return true

	return false
}

// What lies under a slide point, outermost first: the front-most selectable top-level shape, then within a group the
// front-most selectable member under it, and so on down. Empty when nothing selectable is there.
export function hitPath(
	render: SlideRender | undefined,
	point: { readonly x: number; readonly y: number },
	slack: number,
	selected: ReadonlySet<number> = new Set()
): SlideShape[] {
	if (render === undefined) return []

	const index = shapeIndex(render)
	const path: SlideShape[] = []
	let level: readonly SlideShape[] = slideShapes(render)

	while (path.length < 129) {
		let found: SlideShape | undefined

		for (let k = level.length - 1; k >= 0 && found === undefined; k--) {
			const shape = level[k] as SlideShape

			if (selectable(shape) && hitsDeep(index, shape, point.x, point.y, slack, selected)) found = shape
		}

		if (found === undefined) break

		path.push(found)

		const members = index.members.get(found.id)

		if (members === undefined || members.length === 0) break

		level = members
	}

	return path
}

// What a press selects, PowerPoint's way into groups: the first click on a group selects the group; a click on it
// once it is selected selects the member under the press (`into`, on a release without a drag, so a drag still moves
// the group); while members of a group are selected, a click on another member of that group selects it at once;
// anywhere else the top-level shape. One level per click (a group in a group is selected before its own members).
export interface ClickTarget {
	readonly shape: SlideShape
	readonly into?: SlideShape
}

export function clickTarget(
	render: SlideRender | undefined,
	ids: readonly number[],
	point: { readonly x: number; readonly y: number },
	slack: number
): ClickTarget | undefined {
	const selected = new Set(ids)
	const path = hitPath(render, point, slack, selected)
	const outer = path[0]

	if (outer === undefined) return undefined

	const open = new Set<number>()

	for (const id of ids) {
		const parent = shapeOf(render, id)?.parent

		if (parent !== undefined) open.add(parent)
	}

	for (let k = path.length - 1; k >= 0; k--) {
		const shape = path[k] as SlideShape
		const inner = path[k + 1]

		if (selected.has(shape.id)) return inner === undefined ? { shape } : { shape, into: inner }
		if (open.has(shape.id)) return { shape: inner ?? shape }
	}

	return { shape: outer }
}

// The group whose members are selected (the dashed frame PowerPoint keeps around it); undefined at the slide's level.
export function selectionGroup(render: SlideRender | undefined, shapes: readonly SlideShape[]): SlideShape | undefined {
	const parent = shapes[0]?.parent

	return parent === undefined ? undefined : shapeOf(render, parent)
}

// Where each shape of the slide sits, members included ("group:id", 0 for the slide's level): what selectNew compares
// after a command that moves shapes between levels (group, ungroup inside a group).
export function placements(render: SlideRender | undefined): string[] {
	if (render === undefined) return []

	const out: string[] = []

	for (const shape of shapeIndex(render).byId.values()) out.push(`${String(shape.parent ?? 0)}:${String(shape.id)}`)

	return out
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

// Slide point (px, py) in the box's own frame, relative to its centre: turned back by rot.
function unturned(xfrm: Xfrm, px: number, py: number): { dx: number; dy: number } {
	const dx = px - (xfrm.x + xfrm.cx / 2)
	const dy = py - (xfrm.y + xfrm.cy / 2)

	if (xfrm.rot === 0) return { dx, dy }

	const angle = (-xfrm.rot / 60000 / 180) * Math.PI
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)

	return { dx: dx * cos - dy * sin, dy: dx * sin + dy * cos }
}

// Whether slide point (px, py) lies on the shape's box as it shows, within `slack` EMU.
export function onShape(xfrm: Xfrm, px: number, py: number, slack: number): boolean {
	const { dx, dy } = unturned(xfrm, px, py)

	return Math.abs(dx) <= xfrm.cx / 2 + slack && Math.abs(dy) <= xfrm.cy / 2 + slack
}

// Squared distance from (x, y) to the segment (ax, ay)-(bx, by).
function segmentDistance2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
	const ex = bx - ax
	const ey = by - ay
	const length2 = ex * ex + ey * ey
	const t = length2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / length2)) : 0
	const nx = ax + t * ex - x
	const ny = ay + t * ey - y

	return nx * nx + ny * ny
}

// Whether slide point (px, py) lies within `slack` EMU of a line's stroke as it shows: the segment from the box's
// top-left to its bottom-right corner, or `path` (x y pairs in the box's EMU before its flips and turn, a NaN pair
// between subpaths), mirrored by the flips and turned with the box (PowerPoint hits a line only near its stroke).
export function onLine(xfrm: Xfrm, path: readonly number[] | undefined, px: number, py: number, slack: number): boolean {
	const turned = unturned(xfrm, px, py)
	// Into the unflipped box, origin at its top-left corner.
	const x = (xfrm.flipH ? -turned.dx : turned.dx) + xfrm.cx / 2
	const y = (xfrm.flipV ? -turned.dy : turned.dy) + xfrm.cy / 2

	if (x < -slack || y < -slack || x > xfrm.cx + slack || y > xfrm.cy + slack) return false

	const slack2 = slack * slack

	if (path === undefined) return segmentDistance2(x, y, 0, 0, xfrm.cx, xfrm.cy) <= slack2

	for (let k = 2; k + 1 < path.length; k += 2) {
		const ax = path[k - 2] ?? Number.NaN
		const ay = path[k - 1] ?? Number.NaN
		const bx = path[k] ?? Number.NaN
		const by = path[k + 1] ?? Number.NaN

		if (Number.isNaN(ax) || Number.isNaN(bx)) continue
		if (segmentDistance2(x, y, ax, ay, bx, by) <= slack2) return true
	}

	return false
}

// Whether slide point (px, py) hits the shape: a line near its stroke, any other shape on its box.
function hitsShape(shape: SlideShape, px: number, py: number, slack: number): boolean {
	return shape.line === true ? onLine(shape.xfrm, shape.path, px, py, slack) : onShape(shape.xfrm, px, py, slack)
}

// The front-most selectable shape at a slide point.
export function shapeAt(
	shapes: readonly SlideShape[],
	point: { readonly x: number; readonly y: number },
	slack: number
): SlideShape | undefined {
	for (let k = shapes.length - 1; k >= 0; k--) {
		const shape = shapes[k] as SlideShape

		if (selectable(shape) && hitsShape(shape, point.x, point.y, slack)) return shape
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
	// Shape ids, in the order they were selected (the first is the one Tab moves on from): top-level shapes, or
	// members of one group.
	readonly ids: readonly number[]
	// A command that adds or removes shapes (group, ungroup) asked to select what the next render of this slide has
	// that `before` did not: top-level ids, or `placements` (any level; the outermost new ones are selected).
	readonly pending?: { readonly slide: SlideRef; readonly before: ReadonlySet<number | string>; readonly deep: boolean }
}

export interface ShapeSelection {
	getSnapshot(): ShapeSelectionState
	subscribe(listener: () => void): () => void
	// The slide in view: another slide clears the selection.
	show(slide: SlideRef | undefined): void
	set(ids: readonly number[]): void
	toggle(id: number): void
	clear(): void
	// After a command on `slide`, select the shapes the next render has beyond `before` (top-level ids, or the
	// render's `placements` to compare every level). The returned withdraw, for a command that was refused: the
	// selection goes back to what it was, unless the request was resolved or replaced meanwhile.
	selectNew(slide: SlideRef, before: Iterable<number> | { readonly placements: Iterable<string> }): () => void
	// The render of the slide in view arrived: keep only ids it still has, resolve a pending selectNew.
	reconcile(render: SlideRender): void
}

const EMPTY: ShapeSelectionState = { slide: undefined, ids: [] }

// The shapes of the render at a placement `before` did not hold, the outermost only (a new group's members are not
// new on their own), back to front.
function freshPlacements(render: SlideRender, before: ReadonlySet<number | string>): SlideShape[] {
	const fresh = [...shapeIndex(render).byId.values()].filter(shape => !before.has(`${String(shape.parent ?? 0)}:${String(shape.id)}`))
	const ids = new Set(fresh.map(shape => shape.id))

	return fresh.filter(shape => shape.parent === undefined || !ids.has(shape.parent))
}

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
			const deep = "placements" in before
			const asked = { slide, before: new Set<number | string>(deep ? before.placements : before), deep }
			const ids = state.ids

			commit({ slide: state.slide, ids, pending: asked })

			return () => {
				if (state.pending === asked) commit({ slide: state.slide, ids })
			}
		},
		reconcile: render => {
			if (render.ref !== state.slide) return

			const shapes = slideShapes(render)
			const pending = state.pending

			if (pending !== undefined && pending.slide === render.ref) {
				const fresh = pending.deep ? freshPlacements(render, pending.before) : shapes.filter(shape => !pending.before.has(shape.id))

				// The command's render may not be this one yet (an older render arriving first changes nothing).
				if (fresh.length > 0) commit({ slide: state.slide, ids: fresh.map(shape => shape.id) })

				return
			}

			const top = new Set(shapes.map(shape => shape.id))
			const kept = state.ids.every(id => top.has(id)) ? state.ids : state.ids.filter(id => shapeOf(render, id) !== undefined)

			if (kept.length !== state.ids.length) commit({ slide: state.slide, ids: kept })
		}
	}
}

export function useShapeSelection(store: ShapeSelection): ShapeSelectionState {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

// The selected shapes in back-to-front order (members in their groups' order).
export function selectedShapes(render: SlideRender | undefined, state: ShapeSelectionState): SlideShape[] {
	if (render === undefined || render.ref !== state.slide || state.ids.length === 0) return []

	const ids = new Set(state.ids)
	const top = slideShapes(render).filter(shape => ids.has(shape.id))

	if (top.length === ids.size) return top

	for (const members of shapeIndex(render).members.values()) for (const shape of members) if (ids.has(shape.id)) top.push(shape)

	return top
}

// What the selection holds, for the ribbon's contextual tabs.
export type SelectionKind = "shape" | "picture" | "table" | "chart" | "smartart" | "video" | "audio"

export function selectionKinds(shapes: readonly SlideShape[]): ReadonlySet<SelectionKind> {
	const kinds = new Set<SelectionKind>()

	for (const shape of shapes) {
		if (shape.media !== undefined) {
			kinds.add(shape.media.kind)

			continue
		}

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
