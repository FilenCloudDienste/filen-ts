import type { LockReason, ShapeLocks, ShapeNode, SlideNode, SlideRef } from "./model"
import type { LayerRole } from "./output"

// A slide's own objects as the Selection Pane lists them: every shape of the slide, hidden ones included (a render
// draws none of those), groups with their members, back to front as the slide stacks them. Plain data, read on
// demand (the pane asks for it per render of the slide while it is open), never kept.

export interface OutlineShape {
	readonly id: number
	// cNvPr name (ODF draw:name); "" when the file gives none.
	readonly name: string
	readonly hidden: boolean
	readonly role: Exclude<LayerRole, "master" | "layout">
	// What it plays, when it is a medium.
	readonly media?: "audio" | "video"
	// Why the editor may not change it (it is listed, its eye and name are not offered).
	readonly lock?: LockReason
	readonly locks?: ShapeLocks
	// A group's members, back to front.
	readonly children?: readonly OutlineShape[]
}

export interface SlideOutline {
	readonly slide: SlideRef
	// The slide node's revision the outline was read at (a render of the same revision shows the same shapes).
	readonly revision: number
	readonly shapes: readonly OutlineShape[]
}

// Groups nest at most this deep in the outline (deeper members are left out, as the renderer bounds its walks).
const MAX_DEPTH = 128

function roleOf(shape: ShapeNode): OutlineShape["role"] {
	if (shape.ph !== undefined && shape.kind !== "frame") return "placeholder"

	switch (shape.kind) {
		case "pic":
			return shape.media === undefined ? "picture" : "media"
		case "grpSp":
			return "group"
		case "ink":
			return "ink"
		case "frame": {
			const kind = shape.frame?.kind

			return kind === "table" || kind === "chart" || kind === "smartart" || kind === "ole" || kind === "media" ? kind : "shape"
		}
		default:
			return shape.ink === true ? "ink" : "shape"
	}
}

function outlineOf(shapes: readonly ShapeNode[], depth: number): OutlineShape[] {
	const out: OutlineShape[] = []

	for (const shape of shapes) {
		// An ODP master's field shown on the slide: no element of the slide, nothing the pane could change.
		if (shape.synthetic === true) continue

		const children = shape.kind === "grpSp" && depth < MAX_DEPTH ? outlineOf(shape.children ?? [], depth + 1) : undefined

		out.push({
			id: shape.id,
			name: shape.name,
			hidden: shape.hidden,
			role: roleOf(shape),
			...(shape.media === undefined ? {} : { media: shape.media.kind }),
			...(shape.lock === undefined ? {} : { lock: shape.lock }),
			...(shape.locks === undefined ? {} : { locks: shape.locks }),
			...(children === undefined ? {} : { children })
		})
	}

	return out
}

export function slideOutline(node: SlideNode): SlideOutline {
	return { slide: node.ref, revision: node.revision, shapes: outlineOf(node.shapes, 0) }
}
