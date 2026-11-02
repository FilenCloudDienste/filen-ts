import type { EmitPiece } from "../../../pptx/write/types"
import {
	insertedImage,
	insertedImageWritten,
	noteSourcePictureSize,
	pictureFillOf,
	sourcePictureSize,
	type PictureFill,
	type PictureSize
} from "../../../presentation/edit/apply/picture"
import type { DeckOp, InsertedImage, PictureAdjust } from "../../../presentation/edit/ops"
import { isIssuedName } from "../../../presentation/issuedNames"
import { refused, type Deck, type FillProps, type Refused, type ShapeNode } from "../../../presentation/model"
import { findShape } from "../../../presentation/edit/changes"
import type { Slicing } from "../../../opc/index"
import { decodeUtf8, escapeAttribute } from "../../../xml/index"
import { pictureSize, type OdpPackageView } from "../../read/document"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily, OdpStylesApi } from "../emit"
import { OdpStyles, declared, hexColor, isRefused, percent, pt, setProperty, styleChanges, type StyleChanges } from "../styles"
import { IDENTITY, OdpShapeWriter, canonicalBox, pictureMirror } from "./shape"
import { altMarkup, frameBox } from "./table"

// The picture family's ODF markup: a draw:frame holding draw:image (ODF 1.3 Part 3 §10.3.4). The frame's box, name,
// title and click action are the shape family's (a source frame is patched there); the picture's fill is written
// here: draw:image naming its Pictures/ entry (an inserted image added to the package as one), and in the frame's
// graphic style its crop as fo:clip (§20.180: top, right, bottom, left of the picture's own size, which an inserted
// image knows) and its adjustments as draw:luminance, draw:contrast, draw:color-mode and draw:image-opacity
// (§20.123, §20.120, §20.121, §20.125).

const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/svg+xml": "svg"
}

// Entries an image of this save already became, by registry id and by content (one entry per distinct image however
// many frames or backgrounds show it, whatever ids the ops gave it).
interface SavedImages {
	readonly ids: Map<number, string>
	readonly byCrc: Map<number, { readonly path: string; readonly bytes: Uint8Array }[]>
}

const entries = new WeakMap<OdpStylesApi, SavedImages>()

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff

	for (const byte of bytes) {
		crc ^= byte

		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
	}

	return (crc ^ 0xffffffff) >>> 0
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) return true
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

// The package path of an inserted image: named by its content and registry id, past every name the package has or a
// package of the session had (an earlier session's insert of the same image has its name), added once per save.
function insertedEntry(styles: OdpStylesApi, deck: Deck, id: number, image: InsertedImage): string {
	let held = entries.get(styles)

	if (held === undefined) {
		held = { ids: new Map(), byCrc: new Map() }
		entries.set(styles, held)
	}

	const known = held.ids.get(id)

	if (known !== undefined) return known

	const crc = crc32(image.bytes)
	const sameCrc = held.byCrc.get(crc) ?? []
	const same = sameCrc.find(entry => sameBytes(entry.bytes, image.bytes))?.path

	if (same !== undefined) {
		held.ids.set(id, same)

		return same
	}

	const stem = `Pictures/inserted-${crc.toString(16).padStart(8, "0")}-${String(id)}`
	const extension = EXTENSIONS[image.contentType] ?? "bin"
	let path = `${stem}.${extension}`

	for (let k = 2; styles.hasEntry?.(path) === true || isIssuedName(deck, path); k++) path = `${stem}-${String(k)}.${extension}`

	styles.addEntry(path, image.bytes, image.contentType)
	held.ids.set(id, path)
	held.byCrc.set(crc, [...sameCrc, { path, bytes: image.bytes }])

	return path
}

// The package entry (no leading slash) a picture fill shows: an inserted image added once per distinct content, one a
// save wrote the entry it became, a source image its own entry.
export function pictureFillEntry(context: OdpEmitContext, fill: Extract<FillProps, { kind: "picture" }>): string | Refused {
	const image = imageOf(context, fill)

	return isRefused(image) ? image : image.path
}

// The entry a fill's image is and the image's own size (for its crop): an inserted image still held is added, one a
// save wrote is the entry it became, a source image is its own entry.
function imageOf(
	context: OdpEmitContext,
	fill: PictureFill
): { readonly path: string; readonly inserted: boolean; readonly size: PictureSize | undefined } | Refused {
	if (fill.inserted !== undefined) {
		const image = insertedImage(context.deck, fill.inserted)

		if (image !== undefined)
			return {
				path: insertedEntry(context.styles, context.deck, fill.inserted, image),
				inserted: true,
				size: pictureSize(image.bytes)
			}

		const written = insertedImageWritten(context.deck, fill.inserted)

		if (written === undefined) return refused("stale", `The inserted image ${String(fill.inserted)} is not held`)

		return { path: entryPath(written.part), inserted: true, size: written.pixels }
	}

	if (fill.part === undefined) return refused("malformed", "A picture fill naming no image")

	return { path: entryPath(fill.part), inserted: false, size: sourcePictureSize(context.deck, fill.part) }
}

function entryPath(part: string): string {
	return part.startsWith("/") ? part.slice(1) : part
}

// Largest image whose header the engine reads for a crop (the reader's own clip limit).
const MAX_SIZED_BYTES = 64 * 1024 * 1024

// Before a crop of a source picture applies: its image's own size from the entry's header, which the crop's fo:clip
// is written in (the engine awaits this; apply refuses the crop when the size stays unknown).
export async function prepareOdpPictureOp(deck: Deck, op: DeckOp, opc: OdpPackageView, slicing?: Slicing): Promise<void> {
	if (op.family !== "picture" || op.kind !== "crop" || op.crop === undefined) return

	const node = deck.nodes.get(op.target.slide)
	const shape = node === undefined ? undefined : findShape(node.shapes, op.target.id)?.shape
	const fill = shape === undefined ? undefined : pictureFillOf(shape)

	if (fill?.part === undefined || fill.inserted !== undefined || sourcePictureSize(deck, fill.part) !== undefined) return

	const name = entryPath(fill.part)
	const entry = opc.entry(name)

	if (entry === undefined || entry.uncompressedSize > MAX_SIZED_BYTES) return

	const size = pictureSize(await opc.read(name, slicing))

	if (size !== undefined && size.width > 0 && size.height > 0) noteSourcePictureSize(deck, fill.part, size)
}

function adjustChanges(changes: StyleChanges, adjust: PictureAdjust): Refused | undefined {
	setProperty(changes, "graphic", "draw:luminance", percent((adjust.brightness ?? 0) / 1000))
	setProperty(changes, "graphic", "draw:contrast", percent((adjust.contrast ?? 0) / 1000))
	setProperty(
		changes,
		"graphic",
		"draw:color-mode",
		adjust.grayscale === true ? "greyscale" : adjust.biLevel !== undefined ? "mono" : "standard"
	)
	setProperty(changes, "graphic", "draw:image-opacity", percent(100 - Math.max(0, Math.min(100_000, adjust.alpha ?? 0)) / 1000))

	if (adjust.duotone !== undefined) {
		for (const color of adjust.duotone) {
			const hex = hexColor(color)

			if (isRefused(hex)) return hex
		}

		return refused("unsupported", "a duotone picture in ODF")
	}

	return undefined
}

// The frame's graphic style changes the fill needs: its crop in lengths of the image's own size, and the adjustments.
// A source picture whose size is not known keeps its own fo:clip (its crop was never edited: apply refuses that).
function fillChanges(
	fill: PictureFill,
	image: { readonly inserted: boolean; readonly size: PictureSize | undefined }
): StyleChanges | Refused {
	const changes = styleChanges()

	if (image.inserted || image.size !== undefined) {
		const crop = fill.crop
		const size = image.size

		if (crop === undefined) {
			setProperty(changes, "graphic", "fo:clip", null)
		} else if (size === undefined) {
			return refused("unsupported", "cropping a picture whose size is not known")
		} else {
			const length = (fraction: number, whole: number): string => pt((fraction / 100_000) * whole)

			setProperty(
				changes,
				"graphic",
				"fo:clip",
				`rect(${length(crop.t, size.height)}, ${length(crop.r, size.width)}, ${length(crop.b, size.height)}, ${length(crop.l, size.width)})`
			)
		}
	}

	if (fill.adjust !== undefined) {
		const failed = adjustChanges(changes, fill.adjust)

		if (failed !== undefined) return failed
	}

	return changes
}

function imageElement(path: string): string {
	return `<draw:image xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><text:p/></draw:image>`
}

function newPicture(context: OdpEmitContext, styles: OdpStyles, shape: ShapeNode, fill: PictureFill): string | Refused {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return refused("unsupported", "A new picture without a box")
	const image = imageOf(context, fill)

	if (isRefused(image)) return image

	const changes = fillChanges(fill, image)

	if (isRefused(changes)) return changes

	setProperty(changes, "graphic", "draw:stroke", "none")
	setProperty(changes, "graphic", "draw:fill", "none")

	const held = canonicalBox(shape, xfrm)
	const mirror = pictureMirror(held)

	if (mirror !== undefined) setProperty(changes, "graphic", "style:mirror", mirror)

	const style = styles.derived("graphic", undefined, changes)
	const name = shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`

	return `<draw:frame${name} draw:style-name="${escapeAttribute(style)}"${frameBox(held)}>${imageElement(image.path)}${altMarkup(shape)}</draw:frame>`
}

// The source frame's draw:image and graphic style.
function sourceImage(fragment: Fragment, node: number): { readonly image: number; readonly style: string | undefined } {
	const document = fragment.document
	let image = -1

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (image < 0 && fragment.name(child) === "draw:image") image = child

	return { image, style: fragment.attributes(node).get("draw:style-name") }
}

export const emitOdpPicture: OdpEmitFamily = {
	emit(request, context) {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "a picture emit without a shape")
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const styles = context.styles
		const fill = pictureFillOf(shape)
		const fragment = context.document === undefined ? undefined : styles.env.fragmentOf(context.document)
		const writer = new OdpShapeWriter(context, fragment, request.slide, () => undefined)
		const node = writer.sourceNode(shape)

		if (fill === undefined) return refused("unsupported", "a picture emit for a shape without a picture fill")

		if (node === undefined || fragment === undefined) {
			const markup = newPicture(context, styles, shape, fill)

			return isRefused(markup) ? markup : { kind: "markup", pieces: [markup] }
		}

		const source = sourceImage(fragment, node)
		const image = imageOf(context, fill)

		if (isRefused(image)) return image
		if (source.image < 0) return refused("malformed", "a picture frame without its draw:image")

		const changes = fillChanges(fill, image)

		if (isRefused(changes)) return changes

		const pieces = writer.element(shape, IDENTITY, { xfrm: true, alt: true, name: true, hidden: true, actions: true }, true)

		if (isRefused(pieces)) return pieces

		const style = changes.attributes.size === 0 ? undefined : styles.derived("graphic", source.style, changes)
		const out: EmitPiece[] = []

		// Spans of the source frame are written as their text: the shape writer nests this markup in the frame it
		// patches, which takes markup only (a picture frame's children are small).
		for (const piece of pieces) {
			if (typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === source.image) {
				out.push(
					image.inserted
						? declared(imageElement(image.path), fragment.namespaces.inScope(source.image))
						: decodeUtf8(fragment.document.raw(source.image))
				)
			} else if (typeof piece === "object" && !(piece instanceof Uint8Array)) {
				out.push(decodeUtf8(fragment.document.raw(piece.hole)))
			} else if (piece instanceof Uint8Array) {
				out.push(decodeUtf8(piece))
			} else if (style !== undefined && typeof piece === "string" && piece.startsWith("<draw:frame")) {
				out.push(
					piece
						.replace(/ draw:style-name="[^"]*"/u, "")
						.replace(/^<draw:frame/u, `<draw:frame draw:style-name="${escapeAttribute(style)}"`)
				)
			} else {
				out.push(piece)
			}
		}

		return { kind: "markup", pieces: out }
	}
}
