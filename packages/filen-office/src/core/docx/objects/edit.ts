import type { Node } from "prosemirror-model"
import { NodeSelection, type EditorState, type Transaction } from "prosemirror-state"
import { AttrStep, ReplaceAroundStep, ReplaceStep, type Step } from "prosemirror-transform"
import {
	CROP_MAX_PAD,
	CROP_WHOLE,
	sensibleCrop,
	type DocxCrop,
	type DocxRelativeH,
	type DocxRelativeV,
	type DocxWrapMode
} from "../edit/commands/drawings"
import type { DocxEditContext } from "../edit/context"
import { markCommand } from "../edit/invariants/index"
import type { DocumentCommandContext } from "../edit/registry"
import { NO_SOURCE, docxSchema, type DrawingOverrides } from "../edit/schema"
import { tableCellMargins } from "../edit/tables/margins"
import { tableMap } from "../edit/tables/map"
import { paddedGrid } from "../edit/tables/ops"
import { vmlAltText, type DrawingInfo } from "../model/drawings"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/index"
import { EMU_PER_INCH, naturalExtent, sniffImage, type DocxImageInfo, type DocxImageRefusal } from "./images"

// Pictures, shapes, charts and text boxes as objects: what each is as the source has it and as commands
// changed it (a drawing node's `overrides`), and the transactions drawing commands make. Everything is
// read from the drawing's own markup when asked, never by walking the document.

const nodes = docxSchema.nodes

// What drawing commands set on a drawing node (`overrides`), beyond the schema's: a quarter-turn rotation,
// a new picture's drawing id, the PNG Word shows in place of a new SVG picture and a picture's crop (its
// a:srcRect sides, DocxCrop units).
export interface DrawingEdit extends DrawingOverrides {
	readonly wrap?: DocxWrapMode
	readonly relH?: DocxRelativeH
	readonly relV?: DocxRelativeV
	readonly cropLeft?: number
	readonly cropTop?: number
	readonly cropRight?: number
	readonly cropBottom?: number
}

export type DrawingKind = "picture" | "shape" | "chart" | "group" | "textbox" | "object"

// A drawing as it is now (its source with the commands' overrides).
export interface DrawingState {
	readonly kind: DrawingKind
	readonly wrap: DocxWrapMode
	// EMUs.
	readonly cx: number
	readonly cy: number
	// The anchor's offsets (EMUs) from relH / relV; undefined while it is aligned (or inline).
	readonly posX: number | undefined
	readonly posY: number | undefined
	readonly relH: DocxRelativeH
	readonly relV: DocxRelativeV
	readonly descr: string
	readonly rot: number
	// What commands may change.
	readonly resizable: boolean
	readonly rotatable: boolean
	readonly placeable: boolean
	// Word locks the aspect ratio of pictures it inserts (a:picLocks / a:graphicFrameLocks noChangeAspect).
	readonly lockAspect: boolean
	// Rotated (0..359) as the source has it, which the inline extent effect accounts for.
	readonly sourceRot: number
	// A picture's crop (a:srcRect), and whether drawing.crop may change it: a picture whose blip fill the
	// editor reads (a crop it cannot read, or one leaving nothing, stays as it is).
	readonly crop: DocxCrop
	readonly croppable: boolean
	// Mirrored (a:xfrm flipH / flipV): which side of the page a crop's side shows on.
	readonly flipH: boolean
	readonly flipV: boolean
}

export const NO_CROP: DocxCrop = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 })
const INTEGER = /^-?\d+$/

// ST_PositiveCoordinate as commands bound it.
const MAX_EXTENT = 2147483647

const RELATIVE_H = new Set(["margin", "page", "column", "character", "leftMargin", "rightMargin", "insideMargin", "outsideMargin"])
const RELATIVE_V = new Set(["margin", "page", "paragraph", "line", "topMargin", "bottomMargin", "insideMargin", "outsideMargin"])

interface SourceFacts {
	readonly state: DrawingState
}

const facts = new WeakMap<DrawingInfo, SourceFacts>()

function kindOf(drawing: DrawingInfo): DrawingKind {
	switch (drawing.graphic) {
		case "picture":
			return "picture"
		case "shape":
			return drawing.textboxes > 0 ? "textbox" : "shape"
		case "group":
		case "canvas":
			return "group"
		case "chart":
		case "chartEx":
			return "chart"
		default:
			return "object"
	}
}

// The a:xfrm of a drawing's graphic (its picture's, shape's or group's own), or -1 (charts and diagrams
// have none).
export function graphicTransform(part: StoryPart, drawing: DrawingInfo): number {
	if (drawing.graphicData < 0) return -1

	const document = part.document
	const reader = part.reader
	const top = document.firstChildElement(drawing.graphicData)

	if (top < 0) return -1

	for (let child = document.firstChildElement(top); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "spPr" || local === "grpSpPr") return reader.child(child, Ns.A, "xfrm")
	}

	return -1
}

// A picture's own blip fill (pic:pic/pic:blipFill holding an a:blip), or -1.
export function pictureFill(part: StoryPart, drawing: DrawingInfo): number {
	if (drawing.graphic !== "picture" || drawing.graphicData < 0) return -1

	const reader = part.reader
	const picture = reader.child(drawing.graphicData, Ns.Pic, "pic")
	const fill = picture < 0 ? -1 : reader.child(picture, Ns.Pic, "blipFill")

	return fill >= 0 && reader.child(fill, Ns.A, "blip") >= 0 ? fill : -1
}

// The crop of blip fill `fill` (undefined: one the editor does not read, a side not a whole number).
function cropOf(part: StoryPart, fill: number): DocxCrop | undefined {
	const reader = part.reader
	const rect = reader.child(fill, Ns.A, "srcRect")

	if (rect < 0) return NO_CROP

	const side = (name: string): number | undefined => {
		const value = reader.attr(rect, Ns.None, name)

		if (value === undefined) return 0

		const number = INTEGER.test(value.trim()) ? Number(value.trim()) : Number.NaN

		return number >= -CROP_MAX_PAD && number <= CROP_WHOLE ? number + 0 : undefined
	}
	const [left, top, right, bottom] = [side("l"), side("t"), side("r"), side("b")]

	if (left === undefined || top === undefined || right === undefined || bottom === undefined) return undefined

	return left === 0 && top === 0 && right === 0 && bottom === 0 ? NO_CROP : Object.freeze({ left, top, right, bottom })
}

function locksAspect(part: StoryPart, drawing: DrawingInfo): boolean {
	const reader = part.reader

	if (drawing.frame < 0) return false

	const frameLocks = reader.descendant(reader.child(drawing.frame, Ns.WP, "cNvGraphicFramePr"), Ns.A, "graphicFrameLocks")

	// xsd:boolean: "1" or "true" (some producers write words).
	if (frameLocks >= 0 && reader.flag(frameLocks, Ns.None, "noChangeAspect")) return true

	const picLocks = drawing.graphicData < 0 ? -1 : reader.descendant(drawing.graphicData, Ns.A, "picLocks")

	return picLocks >= 0 && reader.flag(picLocks, Ns.None, "noChangeAspect")
}

function wrapOf(drawing: DrawingInfo): DocxWrapMode {
	const anchor = drawing.anchor

	if (drawing.placement !== "anchor" || anchor === undefined) return "inline"
	if (anchor.wrap === "none" || anchor.wrap === "unknown") return anchor.behindDoc ? "behind" : "inFront"

	return anchor.wrap
}

function normalizeDegrees(value: number): number {
	const turned = Math.round(value) % 360

	return turned < 0 ? turned + 360 : turned
}

// Whether a drawing is an mc:Fallback's (its mc:Choice, which readers that understand it show, is markup the
// editor does not read: changing only the fallback would leave the two apart).
function inFallback(part: StoryPart, node: number): boolean {
	const document = part.document

	for (let at = document.parent(node); at >= 0; at = document.parent(at)) {
		if (part.reader.group(at) === Ns.MC && document.localName(at) === "Fallback") return true
	}

	return false
}

// What a source drawing is (read once per drawing).
function sourceFacts(context: DocxEditContext, drawing: DrawingInfo): SourceFacts {
	let found = facts.get(drawing)

	if (found !== undefined) return found

	const part = drawingPart(context, drawing)
	const kind = kindOf(drawing)
	const xfrm = part === undefined ? -1 : graphicTransform(part, drawing)
	const sourceRot = part === undefined || xfrm < 0 ? 0 : normalizeDegrees(part.reader.int(xfrm, Ns.None, "rot", 0) / 60000)
	const anchor = drawing.anchor
	const fill = part === undefined ? -1 : pictureFill(part, drawing)
	const crop = fill < 0 || part === undefined ? undefined : cropOf(part, fill)
	const flipped = (name: string): boolean => part !== undefined && xfrm >= 0 && part.reader.flag(xfrm, Ns.None, name)
	// Charts and diagrams have no shape of their own: only their frame's size changes.
	const known =
		drawing.graphic !== "ink" &&
		drawing.graphic !== "lockedCanvas" &&
		drawing.graphic !== "unknown" &&
		part !== undefined &&
		!inFallback(part, drawing.node)

	found = {
		state: {
			kind,
			wrap: wrapOf(drawing),
			cx: drawing.width,
			cy: drawing.height,
			posX:
				anchor?.horizontal?.align === undefined
					? (anchor?.horizontal?.offset ?? (anchor === undefined ? undefined : 0))
					: undefined,
			posY: anchor?.vertical?.align === undefined ? (anchor?.vertical?.offset ?? (anchor === undefined ? undefined : 0)) : undefined,
			relH: RELATIVE_H.has(anchor?.horizontal?.relativeFrom ?? "") ? (anchor?.horizontal?.relativeFrom as DocxRelativeH) : "column",
			relV: RELATIVE_V.has(anchor?.vertical?.relativeFrom ?? "") ? (anchor?.vertical?.relativeFrom as DocxRelativeV) : "paragraph",
			descr: part === undefined || drawing.docPr < 0 ? "" : (part.reader.attr(drawing.docPr, Ns.None, "descr") ?? ""),
			rot: sourceRot,
			resizable: known && drawing.frame >= 0 && drawing.width > 0 && drawing.height > 0,
			rotatable: known && xfrm >= 0 && kind !== "chart" && kind !== "object",
			placeable: known && drawing.frame >= 0 && drawing.docPr >= 0,
			lockAspect: part !== undefined && locksAspect(part, drawing),
			sourceRot,
			crop: crop ?? NO_CROP,
			croppable: known && drawing.frame >= 0 && drawing.width > 0 && drawing.height > 0 && crop !== undefined && sensibleCrop(crop),
			flipH: flipped("flipH"),
			flipV: flipped("flipV")
		}
	}
	facts.set(drawing, found)

	return found
}

const NONE: DrawingState = {
	kind: "object",
	wrap: "inline",
	cx: 0,
	cy: 0,
	posX: undefined,
	posY: undefined,
	relH: "column",
	relV: "paragraph",
	descr: "",
	rot: 0,
	resizable: false,
	rotatable: false,
	placeable: false,
	lockAspect: false,
	sourceRot: 0,
	crop: NO_CROP,
	croppable: false,
	flipH: false,
	flipV: false
}

// What a drawing is to a reader, for comparing a written drawing read back with the editor's (gate 2): the
// same for a source drawing with no overrides and for the drawing its changed markup reads back as.
export function drawingSignature(context: DocxEditContext, node: Node): string {
	const state = drawingState(context, node)

	return JSON.stringify([
		node.attrs["kind"],
		state.kind,
		state.wrap,
		state.cx,
		state.cy,
		state.posX ?? null,
		state.posY ?? null,
		state.wrap === "inline" ? null : state.relH,
		state.wrap === "inline" ? null : state.relV,
		state.descr,
		state.rot,
		state.crop.left,
		state.crop.top,
		state.crop.right,
		state.crop.bottom
	])
}

export function drawingEdit(node: Node): DrawingEdit | null {
	return (node.attrs["overrides"] as DrawingEdit | null) ?? null
}

// The source drawing a node stands for (DrawingML only; VML and OLE objects have none here).
export function sourceDrawing(context: DocxEditContext, node: Node): DrawingInfo | undefined {
	if (node.type !== nodes.drawing || node.attrs["kind"] !== "drawing" || node.attrs["src"] === NO_SOURCE) return undefined

	const index = node.attrs["index"] as number

	if (index < 0) return undefined

	return index < context.model.drawings.length ? context.model.drawings[index] : ADDED_DRAWINGS.get(context)?.drawings()[index]
}

// Drawings of parts an editor added after the document was read (a header copied from another part, see
// paged/edits.ts) and those parts: the editor's lists (the model's own at the same indices, then those).
const ADDED_DRAWINGS = new WeakMap<
	DocxEditContext,
	{ readonly drawings: () => readonly (DrawingInfo | undefined)[]; readonly parts?: () => readonly (StoryPart | undefined)[] }
>()

export function bindAddedDrawings(
	context: DocxEditContext,
	drawings: () => readonly (DrawingInfo | undefined)[],
	parts?: () => readonly (StoryPart | undefined)[]
): void {
	ADDED_DRAWINGS.set(context, parts === undefined ? { drawings } : { drawings, parts })
}

// The part a source drawing is in: the document's, or one an editor added.
function drawingPart(context: DocxEditContext, drawing: DrawingInfo): StoryPart | undefined {
	return context.model.parts[drawing.part] ?? ADDED_DRAWINGS.get(context)?.parts?.()[drawing.part]
}

// What assistive technology calls a drawing: its alternative text as it is now, else its source's title
// (wp:docPr, ECMA-376 Part 1 §20.4.2.5), or a VML shape's alt or title; "" for none.
export function drawingName(context: DocxEditContext, node: Node): string {
	if (node.type !== nodes.drawing) return ""

	const descr = drawingState(context, node).descr.trim()

	if (descr !== "") return descr

	const drawing = sourceDrawing(context, node)

	if (drawing !== undefined) {
		const part = drawingPart(context, drawing)

		return part === undefined || drawing.docPr < 0 ? "" : (part.reader.attr(drawing.docPr, Ns.None, "title")?.trim() ?? "")
	}

	const vml =
		node.attrs["kind"] === "drawing" || node.attrs["src"] === NO_SOURCE ? undefined : context.model.vml[node.attrs["index"] as number]
	const reader = vml === undefined ? undefined : context.model.parts[vml.part]?.reader

	return vml === undefined || reader === undefined ? "" : vmlAltText(reader, vml.shape)
}

// Whether the node is a picture a command inserted.
export function isNewPicture(node: Node): boolean {
	return node.type === nodes.drawing && node.attrs["src"] === NO_SOURCE && typeof drawingEdit(node)?.media === "number"
}

// The drawing as it is now: what its source says with the commands' overrides on top.
export function drawingState(context: DocxEditContext, node: Node): DrawingState {
	const edit = drawingEdit(node)
	let base: DrawingState

	if (isNewPicture(node)) {
		base = { ...NONE, kind: "picture", resizable: true, rotatable: true, placeable: true, lockAspect: true, croppable: true }
	} else {
		const drawing = sourceDrawing(context, node)

		if (drawing === undefined) return NONE

		base = sourceFacts(context, drawing).state
	}

	if (edit === null) return base

	const wrap = edit.wrap ?? base.wrap
	const floating = wrap !== "inline"
	const cropped =
		edit.cropLeft === undefined && edit.cropTop === undefined && edit.cropRight === undefined && edit.cropBottom === undefined
			? base.crop
			: Object.freeze({
					left: edit.cropLeft ?? base.crop.left,
					top: edit.cropTop ?? base.crop.top,
					right: edit.cropRight ?? base.crop.right,
					bottom: edit.cropBottom ?? base.crop.bottom
				})

	return {
		...base,
		wrap,
		cx: edit.cx ?? base.cx,
		cy: edit.cy ?? base.cy,
		// A floating drawing aligned stays aligned (no offsets) until moved; one floating anew starts at 0.
		posX: floating ? (edit.posX ?? base.posX ?? (base.wrap === "inline" ? 0 : undefined)) : undefined,
		posY: floating ? (edit.posY ?? base.posY ?? (base.wrap === "inline" ? 0 : undefined)) : undefined,
		relH: edit.relH ?? base.relH,
		relV: edit.relV ?? base.relV,
		descr: edit.descr ?? base.descr,
		rot: edit.rot ?? base.rot,
		crop: cropped
	}
}

// The drawing the selection is (a node selection of one), or undefined.
export function selectedDrawing(state: EditorState): { readonly pos: number; readonly node: Node } | undefined {
	const selection = state.selection

	if (!(selection instanceof NodeSelection) || selection.node.type !== nodes.drawing) return undefined

	return { pos: selection.from, node: selection.node }
}

// Overrides to set (undefined: back to the source's).
export type DrawingChanges = { readonly [K in keyof DrawingEdit]?: DrawingEdit[K] | undefined }

// Drawing `node` at `pos` with `changes` made to its overrides (one undo step; null when nothing changes).
// Values equal to the source's are dropped, so undoing by hand leaves the drawing as its source again.
export function changeDrawing(
	state: EditorState,
	context: DocxEditContext,
	pos: number,
	node: Node,
	changes: DrawingChanges
): Transaction | null {
	const current = drawingEdit(node) ?? {}
	const next: Record<string, unknown> = { ...current }

	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete next[key]
		else next[key] = value
	}

	if (!isNewPicture(node)) {
		const drawing = sourceDrawing(context, node)
		const base = drawing === undefined ? undefined : sourceFacts(context, drawing).state

		if (base !== undefined) {
			const same: Record<string, unknown> = {
				cx: base.cx,
				cy: base.cy,
				descr: base.descr,
				rot: base.rot,
				wrap: base.wrap,
				relH: base.relH,
				relV: base.relV,
				posX: base.posX,
				posY: base.posY,
				cropLeft: base.crop.left,
				cropTop: base.crop.top,
				cropRight: base.crop.right,
				cropBottom: base.crop.bottom
			}

			for (const key of Object.keys(next)) if (next[key] === same[key]) delete next[key]

			// A position is the anchor's as a whole: kept while any part of it changed.
			if (["posX", "posY", "relH", "relV"].some(key => key in next) && (next["wrap"] ?? base.wrap) !== "inline") {
				next["posX"] = changes.posX ?? current.posX ?? base.posX ?? 0
				next["posY"] = changes.posY ?? current.posY ?? base.posY ?? 0
				next["relH"] = changes.relH ?? current.relH ?? base.relH
				next["relV"] = changes.relV ?? current.relV ?? base.relV
			}
		}
	}

	const value = Object.keys(next).length === 0 ? null : (Object.freeze(next) as DrawingEdit)

	if (sameEdit(drawingEdit(node), value)) return null

	return markCommand(state.tr.setNodeAttribute(pos, "overrides", value))
}

function sameEdit(a: DrawingEdit | null, b: DrawingEdit | null): boolean {
	if (a === b) return true
	if (a === null || b === null) return false

	const keys = Object.keys(a)

	return (
		keys.length === Object.keys(b).length &&
		keys.every(key => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
	)
}

// The extent a resize to (cx, cy) gives: with `keepRatio`, the drawing's proportions at the larger scale
// asked for (as a corner handle drags).
export function resizedExtent(state: DrawingState, cx: number, cy: number, keepRatio: boolean): { cx: number; cy: number } {
	if (!keepRatio || state.cx <= 0 || state.cy <= 0) return { cx, cy }

	const scale = Math.max(cx / state.cx, cy / state.cy)

	return { cx: Math.max(1, Math.round(state.cx * scale)), cy: Math.max(1, Math.round(state.cy * scale)) }
}

// The extent cropping a picture as `state` is to `crop` gives, its scale kept (the part of the picture shown
// grows or shrinks, as Word's crop does), or undefined when it would be out of range. An extent back within
// rounding of the source's at the source's crop is the source's (so cropping back undoes exactly).
export function croppedExtent(
	state: DrawingState,
	source: DrawingState | undefined,
	crop: DocxCrop
): { readonly cx: number; readonly cy: number } | undefined {
	const was = state.crop
	const fromX = CROP_WHOLE - was.left - was.right
	const fromY = CROP_WHOLE - was.top - was.bottom

	if (fromX <= 0 || fromY <= 0 || !sensibleCrop(crop)) return undefined

	let cx = Math.round((state.cx * (CROP_WHOLE - crop.left - crop.right)) / fromX)
	let cy = Math.round((state.cy * (CROP_WHOLE - crop.top - crop.bottom)) / fromY)
	const near = (value: number, to: number): boolean => Math.abs(value - to) <= Math.max(2, to * 1e-4)

	if (source !== undefined && sameCrop(crop, source.crop) && near(cx, source.cx) && near(cy, source.cy)) {
		cx = source.cx
		cy = source.cy
	}

	return cx >= 1 && cy >= 1 && cx <= MAX_EXTENT && cy <= MAX_EXTENT ? { cx, cy } : undefined
}

export function sameCrop(a: DocxCrop, b: DocxCrop): boolean {
	return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

// The source state of a drawing node (its overrides aside), or undefined for a new picture.
export function sourceState(context: DocxEditContext, node: Node): DrawingState | undefined {
	if (isNewPicture(node)) return undefined

	const drawing = sourceDrawing(context, node)

	return drawing === undefined ? undefined : sourceFacts(context, drawing).state
}

// ---- media in use --------------------------------------------------------------------------------------

function addFromNode(node: Node, out: Set<number>): void {
	const visit = (child: Node): boolean => {
		if (child.type === nodes.drawing) {
			const edit = drawingEdit(child)

			if (typeof edit?.media === "number") out.add(edit.media)
			if (typeof edit?.fallback === "number") out.add(edit.fallback)

			return false
		}

		return !child.isLeaf
	}

	if (visit(node)) node.descendants(visit)
}

function addFromValue(value: unknown, out: Set<number>): void {
	if (value === null || typeof value !== "object") return

	const edit = value as DrawingEdit

	if (typeof edit.media === "number") out.add(edit.media)
	if (typeof edit.fallback === "number") out.add(edit.fallback)
}

function addFromStep(step: Step, out: Set<number>): void {
	if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
		step.slice.content.forEach(child => addFromNode(child, out))
	} else if (step instanceof AttrStep) {
		addFromValue(step.value, out)
	} else {
		// Other steps (marks, attributes of blocks) carry no drawings; an unknown kind is read whole.
		const json = JSON.stringify(step.toJSON())

		if (json.includes('"media"') || json.includes('"fallback"')) {
			for (const match of json.matchAll(/"(?:media|fallback)":(\d+)/g)) out.add(Number(match[1]))
		}
	}
}

interface HistoryBranch {
	readonly items: { forEach(f: (item: { readonly step?: Step }) => void): void }
}

// The undo and redo branches of a state's history (prosemirror-history's plugin state), when it has one.
function historyBranches(state: EditorState): readonly HistoryBranch[] {
	for (const plugin of state.plugins) {
		if ((plugin as unknown as { key: string }).key !== "history$") continue

		const value = plugin.getState(state) as { done?: HistoryBranch; undone?: HistoryBranch } | undefined

		return [value?.done, value?.undone].filter((branch): branch is HistoryBranch => branch !== undefined)
	}

	return []
}

// Every media handle the states can still bring back: in their documents and in their undo and redo
// histories (an undo restores a deleted picture). What a DocxMediaStore may release is everything else.
export function mediaInUse(states: readonly EditorState[]): Set<number> {
	const out = new Set<number>()

	for (const state of states) {
		addFromNode(state.doc, out)

		for (const branch of historyBranches(state)) {
			branch.items.forEach(item => {
				if (item.step !== undefined) addFromStep(item.step, out)
			})
		}
	}

	return out
}

// Handles a picture insertion named (it ran, whatever came of it) or a host gave up. Until then a handle is on
// its way into a command (a host registers a picture, then asks for its alt text, say): no save releases it.
const settledMedia = new WeakMap<DocxEditContext["media"], Set<number>>()

export function settleMedia(context: DocxEditContext, handles: readonly (number | undefined)[]): void {
	let settled = settledMedia.get(context.media)

	if (settled === undefined) {
		settled = new Set()
		settledMedia.set(context.media, settled)
	}

	for (const handle of handles) if (handle !== undefined) settled.add(handle)
}

// Releases the media no state can bring back (after a save, say), of the settled handles given out up to
// `through`.
export function releaseUnusedMedia(context: DocxEditContext, states: readonly EditorState[], through = Infinity): void {
	const keep = mediaInUse(states)
	const settled = settledMedia.get(context.media)
	const last = Math.min(through, context.media.lastHandle)

	for (let handle = 1; handle <= last; handle++) {
		if (settled?.has(handle) !== true) keep.add(handle)
		else if (!keep.has(handle)) settled.delete(handle)
	}

	context.media.releaseUnused(keep, through)
}

// ---- inserting pictures ---------------------------------------------------------------------------------

export const EMU_PER_TWIP = EMU_PER_INCH / 1440
// Layout px are 1/96 inch.
export const EMU_PER_PX = EMU_PER_INCH / 96
// Word's text width without a section to read (6.5 in).
const DEFAULT_TEXT_WIDTH = 9360

// Why the picture of handle `media` (and `fallback`, the PNG an SVG needs) cannot be inserted, or undefined.
export function pictureRefusal(context: DocxEditContext, media: number, fallback: number | undefined): DocxImageRefusal | undefined {
	const found = pictureOf(context, media)

	if (typeof found === "string") return found
	if (found.format !== "svg") return fallback === undefined ? undefined : "fallback"
	if (fallback === undefined) return "fallback"

	const png = pictureOf(context, fallback)

	return typeof png === "string" || png.format === "svg" || png.format === "emf" || png.format === "wmf" ? "fallback" : undefined
}

function pictureOf(context: DocxEditContext, media: number): DocxImageInfo | DocxImageRefusal {
	const bytes = context.media.bytes(media)

	return bytes === undefined ? "corrupt" : sniffImage(bytes)
}

// Whether a picture can go where the selection is: in a paragraph (replacing what is selected).
export function canInsertPicture(state: EditorState): boolean {
	const $from = state.selection.$from
	const $to = state.selection.$to

	return $from.parent.type === nodes.paragraph && $to.parent.type === nodes.paragraph
}

// The box (EMUs) a new picture may take, as Word fits one: its section's text column, as wide as its table cell
// in a table, and as high as the page's text.
function availableBox(context: DocumentCommandContext, state: EditorState): { readonly width: number; readonly height: number } {
	const session = context.session
	const store = context.context.store
	const $from = state.selection.$from
	const model = context.context.model
	const editor = context.editor
	const caret = editor.geometry.locate(state.selection.head)
	const page = caret === undefined ? undefined : editor.page(caret.page)
	const section = model.sections[page?.section ?? -1] ?? model.sections[model.sections.length - 1]
	const body = model.body === undefined ? undefined : model.parts[model.body.part]
	const props =
		section === undefined || body === undefined || section.sectPr < 0 ? undefined : store.section(body.document, section.sectPr)
	const margins = props?.pageMargins
	// A negative top or bottom margin is a fixed one: its size all the same.
	const textHeight = (props?.pageSize?.height ?? 15840) - Math.abs(margins?.top ?? 1440) - Math.abs(margins?.bottom ?? 1440)
	const height = Math.max(1, Math.round(Math.max(textHeight, 288) * EMU_PER_TWIP))

	for (let d = $from.depth - 1; d >= 2; d--) {
		if ($from.node(d).type !== nodes.table_cell) continue

		const map = tableMap($from.node(d - 2), session.story.part, store)
		const row = map.row($from.index(d - 2))
		const index = $from.index(d - 1)
		const start = row.starts[index] ?? 0
		const span = row.spans[index] ?? 1
		const grid = paddedGrid(map, start + span)
		let width = 0

		for (let c = start; c < start + span; c++) width += grid[c] ?? 0

		// Less the table's cell margins.
		const margins = tableCellMargins(session.story.part, context.context, $from.node(d - 2))

		return { width: Math.max(1, Math.round(Math.max(width - margins, 288) * EMU_PER_TWIP)), height }
	}

	if (props === undefined) return { width: Math.round(DEFAULT_TEXT_WIDTH * EMU_PER_TWIP), height }

	const pageWidth = props.pageSize?.width ?? 12240
	const columns = Math.max(1, props.columns?.count ?? 1)
	const text = pageWidth - (margins?.left ?? 1440) - (margins?.right ?? 1440) - (margins?.gutter ?? 0)
	const column = (text - (props.columns?.space ?? 720) * (columns - 1)) / columns

	return { width: Math.max(1, Math.round(Math.max(column, 288) * EMU_PER_TWIP)), height }
}

// Whether drawing `node` (selected) is a picture whose picture Change Picture can swap in place: one a command
// inserted, or a source picture with a blip fill and a crop the editor reads.
function swappable(context: DocxEditContext, node: Node): boolean {
	if (isNewPicture(node)) return true

	const drawing = sourceDrawing(context, node)
	const part = drawing === undefined ? undefined : drawingPart(context, drawing)
	const state = drawingState(context, node)

	return drawing !== undefined && part !== undefined && state.kind === "picture" && state.croppable && pictureFill(part, drawing) >= 0
}

// The transaction inserting the picture of `command` where the selection is, sized as Word sizes it (its
// own size at its resolution, at most the box it goes into), or null when it cannot go there (or is
// refused: see pictureRefusal). A selected picture takes the new one in place (Word's Change Picture): placed,
// turned, formatted and described as it was, its crop reset and the new picture fitted into its box with its own
// proportions. While changes are tracked, or for what is no picture, the selection is replaced as by typing.
export function insertPicture(
	context: DocumentCommandContext,
	command: { readonly media: number; readonly fallback?: number; readonly altText?: string }
): Transaction | null {
	const state = context.session.state
	const edit = context.context

	if (!canInsertPicture(state) || pictureRefusal(edit, command.media, command.fallback) !== undefined) return null
	const image = pictureOf(edit, command.media) as DocxImageInfo
	let { cx, cy } = naturalExtent(image)
	const replaced = selectedDrawing(state)
	const old = replaced === undefined ? undefined : drawingState(edit, replaced.node)

	if (
		replaced !== undefined &&
		old !== undefined &&
		old.cx > 0 &&
		old.cy > 0 &&
		!edit.review.tracking &&
		swappable(edit, replaced.node)
	) {
		const scale = Math.min(old.cx / cx, old.cy / cy)
		const current: Record<string, unknown> = { ...(drawingEdit(replaced.node) ?? {}) }

		delete current["fallback"]

		const overrides: DrawingEdit = Object.freeze({
			...current,
			media: command.media,
			cx: Math.max(1, Math.round(cx * scale)),
			cy: Math.max(1, Math.round(cy * scale)),
			cropLeft: 0,
			cropTop: 0,
			cropRight: 0,
			cropBottom: 0,
			...(command.fallback === undefined ? {} : { fallback: command.fallback }),
			...(command.altText === undefined || command.altText === "" ? {} : { descr: command.altText })
		})
		const tr = state.tr.setNodeAttribute(replaced.pos, "overrides", overrides)

		return markCommand(tr.setSelection(NodeSelection.create(tr.doc, replaced.pos)).scrollIntoView())
	}

	// What is no picture is replaced by the new one where it was, sized as a new picture.
	const picture = old?.kind === "picture"
	const box = picture && old.cx > 0 && old.cy > 0 ? { width: old.cx, height: old.cy } : availableBox(context, state)
	const scale = Math.min(1, box.width / cx, box.height / cy)

	cx = Math.max(1, Math.round(cx * scale))
	cy = Math.max(1, Math.round(cy * scale))

	const placed: DrawingEdit =
		!picture || old.wrap === "inline" || !old.placeable
			? {}
			: { wrap: old.wrap, posX: old.posX ?? 0, posY: old.posY ?? 0, relH: old.relH, relV: old.relV }
	const overrides: DrawingEdit = Object.freeze({
		media: command.media,
		cx,
		cy,
		docPr: edit.ids.next("docPr"),
		...placed,
		...(command.fallback === undefined ? {} : { fallback: command.fallback }),
		...(command.altText === undefined || command.altText === "" ? {} : { descr: command.altText })
	})
	const node = nodes.drawing.create(
		{ src: NO_SOURCE, kind: "drawing", index: -1, anchored: false, overrides },
		null,
		replaced?.node.marks
	)

	// An ordinary insertion (not a command's): while changes are tracked it is recorded as one, and what it
	// replaces is marked deleted.
	return state.tr.replaceSelectionWith(node, replaced === undefined).scrollIntoView()
}

// Where an inline drawing at `pos` stands, as the offsets of a floating one from its column and paragraph
// (what Word keeps when the wrapping changes); empty when it is not laid out.
export function floatingPosition(context: DocumentCommandContext, pos: number): DrawingChanges {
	const editor = context.editor
	const geometry = editor.geometry
	const box = geometry.locate(pos, 1)
	const page = box === undefined ? undefined : editor.page(box.page)

	if (box === undefined || page === undefined) return {}

	const column = geometry.columnBox(page, box.line)
	const $pos = context.session.state.doc.resolve(pos)
	const first = geometry.locate($pos.start(), 1)
	const top = first !== undefined && first.page === box.page ? first.top : box.top

	return {
		relH: "column",
		relV: "paragraph",
		posX: Math.round((box.x - column.left) * EMU_PER_PX),
		posY: Math.round((box.top - top) * EMU_PER_PX)
	}
}
