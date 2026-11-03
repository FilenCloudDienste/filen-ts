import { imageWithinBudget } from "../../../opc/mediaPolicy"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import { refused, type Deck, type EdgeFractions, type FillProps, type Refused, type ShapeNode, type SlideNode } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import { cloneModel, findShape } from "../changes"
import type { InsertedImage, OpOf, PictureAdjust, PictureOp } from "../ops"
import { applyShape } from "./shape"
import { isRefused } from "../../refusal"

// The picture ops on the model, in place. A picture's image, crop and adjustments are its typed picture fill
// (`props.fill`, model.ts): the fill is read from the source at the first edit (PictureReading) and written whole by
// the picture emitters from then on. An image an op inserts lives in the deck's image registry until a save gives it
// a part: the fill names it by its registry id (`inserted`), the render serves it as "inserted:<id>", the emitters add
// its part. Every op but insert is undone by setting the prior fill back (undefined: the source's).

// A picture fill with its adjustments (a:blip's a:lum, a:grayscl, a:biLevel, a:duotone, a:alphaModFix, §20.1.8;
// ODF draw:luminance, draw:contrast, draw:color-mode, draw:opacity). Present: they replace the source's; absent: the
// source's stay.
export type PictureFill = Extract<FillProps, { kind: "picture" }> & { readonly adjust?: PictureAdjust }

// What the engine adds to ApplyContext for pictures: the fill a picture's source holds (p:blipFill, draw:image).
export interface PictureReading extends ApplyContext {
	pictureFill(slide: SlideNode, shape: ShapeNode): PictureFill | Refused | undefined
}

// The image types a picture may hold (the docx preparePicture pipeline re-encodes anything else).
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/svg+xml"])

// Inserted images by deck, by registry id. A redo applies the op as applied, whose fill names its id again. Ids are
// never reused (a freed id stays an alias), so `next` only grows.
interface ImageRegistry {
	readonly images: Map<number, InsertedImage>
	// Images a committed save wrote: their bytes are the package's now (see commitInsertedImages).
	readonly written: Map<number, WrittenImage>
	// The images freed into an alias, by their own object (an op redone after the save names it again).
	readonly writtenFrom: WeakMap<InsertedImage, number>
	next: number
}

const registries = new WeakMap<Deck, ImageRegistry>()

function registryOf(deck: Deck): ImageRegistry {
	let registry = registries.get(deck)

	if (registry === undefined) {
		registry = { images: new Map(), written: new Map(), writtenFrom: new WeakMap(), next: 1 }
		registries.set(deck, registry)
	}

	return registry
}

export function insertedImage(deck: Deck, id: number): InsertedImage | undefined {
	return registries.get(deck)?.images.get(id)
}

// An image into the deck's registry: `id` when the op as applied names it already (a redo), else a new id.
export function registerInsertedImage(deck: Deck, image: InsertedImage, id: number | undefined): number {
	const registry = registryOf(deck)

	// A redo names the image its op inserted: the id again, still held or written by a save since (its alias).
	if (id !== undefined && id > 0 && (registry.images.get(id) === image || registry.writtenFrom.get(image) === id)) return id

	const next = registry.next++

	registry.images.set(next, image)

	return next
}

// An inserted image a committed save wrote, once its registry entry was freed: the part it lives in from then on
// (pptx "/ppt/media/image3.png", ODP "Pictures/…"), and the facts the emitters took from its bytes. A fill (in the
// model or an undo step) that still names "inserted:<id>" is that part.
export interface WrittenImage {
	readonly part: string
	readonly contentType: string
	readonly width: number
	readonly height: number
	// Its pixel size as the file's header says (an ODP crop is in its units), undefined when unread.
	readonly pixels: { readonly width: number; readonly height: number } | undefined
}

export function insertedImageWritten(deck: Deck, id: number): WrittenImage | undefined {
	return registries.get(deck)?.written.get(id)
}

// The part a committed save wrote an inserted image to, by the image itself (what a redo of its op names).
export function insertedImageWrittenFor(deck: Deck, image: InsertedImage): WrittenImage | undefined {
	const registry = registries.get(deck)
	const id = registry?.writtenFrom.get(image)

	return id === undefined ? undefined : registry?.written.get(id)
}

// The inserted images a save wrote: registry id → the name of the entry it added with the registry's own bytes.
export function insertedImagesAdded(deck: Deck, added: ReadonlyMap<object, string>): Map<number, string> {
	const out = new Map<number, string>()

	for (const [id, image] of registries.get(deck)?.images ?? []) {
		const name = added.get(image.bytes)

		if (name !== undefined) out.set(id, name)
	}

	return out
}

// After a save committed: each image it wrote (registry id → model part name) is freed and becomes an alias.
export function commitInsertedImages(
	deck: Deck,
	written: ReadonlyMap<number, string>,
	pixels: (bytes: Uint8Array) => { readonly width: number; readonly height: number } | undefined
): void {
	const registry = registries.get(deck)

	if (registry === undefined) return

	for (const [id, part] of written) {
		const image = registry.images.get(id)

		if (image === undefined) continue

		registry.images.delete(id)
		registry.writtenFrom.set(image, id)
		registry.written.set(id, {
			part,
			contentType: image.contentType,
			width: image.width,
			height: image.height,
			pixels: pixels(image.bytes)
		})
	}
}

// The size of a source picture's image, read from its header by the engine before an op that needs it applies (an
// ODP crop is in lengths of the image's own size, fo:clip §20.180): by deck, by the fill's part. The units are the
// header's (pictureSize: points at the image's own resolution).
export interface PictureSize {
	readonly width: number
	readonly height: number
}

const sourceSizes = new WeakMap<Deck, Map<string, PictureSize>>()

export function sourcePictureSize(deck: Deck, part: string): PictureSize | undefined {
	return sourceSizes.get(deck)?.get(part)
}

export function noteSourcePictureSize(deck: Deck, part: string, size: PictureSize): void {
	let sizes = sourceSizes.get(deck)

	if (sizes === undefined) {
		sizes = new Map()
		sourceSizes.set(deck, sizes)
	}

	sizes.set(part, size)
}

// Whether an ODP crop of this fill can be written: the image's own size is known (an inserted image's bytes, a
// written one's header, a source one's as the engine read it).
function odpCropSized(deck: Deck, fill: PictureFill): boolean {
	if (fill.inserted !== undefined)
		return insertedImage(deck, fill.inserted) !== undefined || insertedImageWritten(deck, fill.inserted)?.pixels !== undefined

	return fill.part !== undefined && sourcePictureSize(deck, fill.part) !== undefined
}

function checkImage(image: InsertedImage): Refused | undefined {
	if (!IMAGE_TYPES.has(image.contentType)) return refused("unsupported", `an image of type ${image.contentType}`)
	if (image.bytes.length === 0 || !(image.width > 0) || !(image.height > 0)) return refused("malformed", "an empty image")
	if (image.width * image.height > DEFAULT_PRESENTATION_BUDGETS.decodedPixels || !imageWithinBudget(image.bytes))
		return refused("tooLarge", `${String(image.width)} × ${String(image.height)} pixels`)

	return undefined
}

export function pictureFillOf(shape: ShapeNode): PictureFill | undefined {
	const fill = shape.props?.fill

	return fill !== undefined && fill !== "none" && fill.kind === "picture" ? fill : undefined
}

interface Found {
	readonly node: SlideNode
	readonly shape: ShapeNode
}

function picture(deck: Deck, target: { readonly slide: SlideNode["ref"]; readonly id: number }): Found | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)
	if (shape.kind !== "pic" || shape.media !== undefined) return refused("unsupported", `shape ${String(target.id)} is not a picture`)
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	return { node, shape }
}

// The fill an edit starts from: the picture's typed fill, else its source's.
function baseFill(found: Found, context: ApplyContext): PictureFill | Refused {
	const typed = pictureFillOf(found.shape)

	if (typed !== undefined) return typed

	const read = "pictureFill" in context ? (context as PictureReading).pictureFill(found.node, found.shape) : undefined

	if (read === undefined) return refused("notImplemented", "reading a source picture here")

	return read
}

function validEdges(edges: EdgeFractions): boolean {
	return (
		[edges.l, edges.t, edges.r, edges.b].every(value => Number.isFinite(value) && Math.abs(value) <= 10_000_000) &&
		edges.l + edges.r < 100_000 &&
		edges.t + edges.b < 100_000
	)
}

function validAdjust(adjust: PictureAdjust): boolean {
	const ranged = (value: number | undefined): boolean =>
		value === undefined || (Number.isFinite(value) && value >= -100_000 && value <= 100_000)

	return ranged(adjust.brightness) && ranged(adjust.contrast) && ranged(adjust.biLevel) && ranged(adjust.alpha)
}

function setFill(found: Found, op: Exclude<PictureOp, { kind: "insert" }>, fill: PictureFill): ApplyResult<typeof op> {
	const prior = pictureFillOf(found.shape)
	const back = {
		family: "shape",
		kind: "setProps",
		target: op.target,
		props: { fill: prior === undefined ? undefined : cloneModel(prior) }
	} as const

	found.shape.props = { ...found.shape.props, fill }
	found.node.revision++

	return { kind: "applied", inverse: { ops: [back], bytes: 0 }, op }
}

function insert(deck: Deck, op: OpOf<"picture"> & { kind: "insert" }, context: ApplyContext): ApplyResult<typeof op> {
	const checked = checkImage(op.image)

	if (checked !== undefined) return checked
	if (op.shape.kind !== "pic" || op.shape.xfrm === undefined) return refused("malformed", "a picture needs a pic shape with a box")

	const prior = pictureFillOf(op.shape)
	const id = registerInsertedImage(deck, op.image, prior?.inserted)
	const { part: _part, inserted: _inserted, ...rest } = prior ?? { kind: "picture" as const }
	// Stretched to the box unless the op tiles it (a:stretch with an empty a:fillRect, as written).
	const placed = rest.tile === undefined && rest.stretch === undefined ? { ...rest, stretch: { l: 0, t: 0, r: 0, b: 0 } } : rest
	const shape: ShapeNode = { ...op.shape, props: { ...op.shape.props, fill: { ...placed, kind: "picture", inserted: id } } }
	const result = applyShape.apply(
		deck,
		{ family: "shape", kind: "insert", slide: op.slide, shape, ...(op.index === undefined ? {} : { index: op.index }) },
		context
	)

	if (result.kind === "refused") return result

	const applied = result.op.family === "shape" && result.op.kind === "insert" ? result.op.shape : shape

	return { kind: "applied", inverse: result.inverse, op: { ...op, shape: { ...shape, id: applied.id } } }
}

function applyOne(deck: Deck, op: PictureOp, context: ApplyContext): ApplyResult<PictureOp> {
	if (op.kind === "insert") return insert(deck, op, context)

	const found = picture(deck, op.target)

	if (isRefused(found)) return found

	switch (op.kind) {
		case "replace": {
			const checked = checkImage(op.image)

			if (checked !== undefined) return checked

			const base = baseFill(found, context)

			if (isRefused(base)) return base

			// Change Picture keeps the box and the adjustments and resets the crop (as PowerPoint does).
			const { part: _part, inserted, crop: _crop, ...rest } = base
			const id = registerInsertedImage(deck, op.image, inserted)

			return setFill(found, op, { ...rest, inserted: id })
		}
		case "crop": {
			if (op.crop !== undefined && !validEdges(op.crop)) return refused("malformed", "a crop past the picture")

			const base = baseFill(found, context)

			if (isRefused(base)) return base

			if (op.crop !== undefined && deck.format === "odp" && !odpCropSized(deck, base))
				return refused("unsupported", "cropping a picture whose image size is not known")

			const { crop: _crop, ...rest } = base

			return setFill(found, op, op.crop === undefined ? rest : { ...rest, crop: { ...op.crop } })
		}
		case "adjust": {
			if (op.adjust !== undefined && !validAdjust(op.adjust)) return refused("malformed", "an adjustment out of range")

			const base = baseFill(found, context)

			if (isRefused(base)) return base

			// Reset (undefined) writes no adjustments at all, not the source's.
			return setFill(found, op, { ...base, adjust: op.adjust === undefined ? {} : cloneModel(op.adjust) })
		}
	}
}

export const applyPicture: ApplyFamily<PictureOp> = {
	apply: (deck, op, context) => applyOne(deck, op, context),
	touches: (op): readonly Touch[] =>
		op.kind === "insert"
			? [{ kind: "shape", slide: op.slide, shape: op.shape.id, dirt: { kind: "node" } }]
			: [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }]
}
