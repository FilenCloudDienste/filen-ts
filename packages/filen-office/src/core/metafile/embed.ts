import {
	DrawingList,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	type DrawingImage,
	type DrawingText,
	type Paint
} from "../drawingml/displayList"
import type { PixelBudget } from "./dib"
import { MAX_COORDS, MAX_ITEMS, MAX_TOTAL_DECODE_PIXELS, MetafileLimit } from "./limits"
import type { ClipNode } from "./clip"
import { effectImage, effectPaint, effectText, pictureEffect, type ColorEffect } from "./effects"
import { mul, type Matrix, type Output } from "./output"
import type { MetafileConversion } from "./types"

// Places converted metafiles into a drawing: each metafile image item is replaced by the metafile's items,
// mapped from its frame onto the image's box (cropped as the picture crops) and clipped to that box.

function grownBytes(array: Uint8Array, needed: number): Uint8Array {
	if (needed <= array.length) return array

	const grown = new Uint8Array(Math.max(needed, array.length * 2))

	grown.set(array)

	return grown
}

function grownFloats(array: Float32Array, needed: number): Float32Array {
	if (needed <= array.length) return array

	const grown = new Float32Array(Math.max(needed, array.length * 2))

	grown.set(array)

	return grown
}

// Copies a source list's items into a target, each placed by `matrix` and clipped by `parentClip` too. The
// source's path data is appended once; its tables are re-interned on first use.
export class ListCopier {
	private readonly target: DrawingList
	private readonly source: DrawingList
	private readonly matrix: Matrix
	private readonly parentClip: number
	private readonly commandBase: number
	private readonly coordBase: number
	private readonly paints = new Map<number, number>()
	private readonly strokes = new Map<number, number>()
	private readonly images = new Map<number, number>()
	private readonly shadows = new Map<number, number>()
	private readonly clips = new Map<number, number>()

	// A picture's effects for everything copied: colours through `effect`, bitmaps taking `picture`'s fields.
	private readonly effect: ColorEffect | undefined
	private readonly picture: DrawingImage | undefined

	// Pixels the picture's colour change may decode, shared by the copiers of one expansion.
	private readonly budget: PixelBudget

	constructor(
		target: DrawingList,
		source: DrawingList,
		matrix: Matrix,
		parentClip: number,
		picture?: DrawingImage,
		budget: PixelBudget = { spend: () => false }
	) {
		this.budget = budget
		this.picture = picture
		this.effect = picture === undefined ? undefined : pictureEffect(picture)
		this.target = target
		this.source = source
		this.matrix = matrix
		this.parentClip = parentClip

		if (target.itemCount + source.itemCount > MAX_ITEMS * 2) throw new MetafileLimit("items")
		if (target.coordCount + source.coordCount > MAX_COORDS * 2) throw new MetafileLimit("coordinates")

		this.commandBase = target.commandCount
		this.coordBase = target.coordCount
		target.commands = grownBytes(target.commands, target.commandCount + source.commandCount)
		target.commands.set(source.commands.subarray(0, source.commandCount), target.commandCount)
		target.commandCount += source.commandCount
		target.coords = grownFloats(target.coords, target.coordCount + source.coordCount)
		target.coords.set(source.coords.subarray(0, source.coordCount), target.coordCount)
		target.coordCount += source.coordCount
	}

	private image(index: number): number {
		if (index < 0) return -1

		let mapped = this.images.get(index)

		if (mapped === undefined) {
			const image: DrawingImage | undefined = this.source.images[index]

			mapped =
				image === undefined
					? -1
					: this.target.image(this.picture === undefined ? image : effectImage(image, this.picture, this.budget))
			this.images.set(index, mapped)
		}

		return mapped
	}

	private paint(index: number): number {
		if (index < 0) return -1

		let mapped = this.paints.get(index)

		if (mapped === undefined) {
			const paint: Paint | undefined = this.source.paints[index]

			const effect = this.effect
			const own = paint === undefined || effect === undefined ? paint : effectPaint(paint, effect)

			mapped = own === undefined ? -1 : this.target.paint(own.kind === "image" ? { ...own, image: this.image(own.image) } : own)
			this.paints.set(index, mapped)
		}

		return mapped
	}

	private stroke(index: number): number {
		if (index < 0) return -1

		let mapped = this.strokes.get(index)

		if (mapped === undefined) {
			const stroke = this.source.strokes[index]

			mapped = stroke === undefined ? -1 : this.target.stroke({ ...stroke, paint: this.paint(stroke.paint) })
			this.strokes.set(index, mapped)
		}

		return mapped
	}

	private shadow(index: number): number {
		if (index < 0) return -1

		let mapped = this.shadows.get(index)

		if (mapped === undefined) {
			const shadow = this.source.shadows[index]

			mapped = shadow === undefined ? -1 : this.target.shadow(shadow)
			this.shadows.set(index, mapped)
		}

		return mapped
	}

	clip(index: number): number {
		if (index < 0) return this.parentClip

		let mapped = this.clips.get(index)

		if (mapped === undefined) {
			const clip = this.source.clips[index]

			if (clip === undefined) {
				mapped = this.parentClip
			} else {
				const earlier = (member: number): number => (member >= 0 && member < index ? this.clip(member) : this.parentClip)
				const shapes = clip.shapes?.map(shape => ({
					...shape,
					matrix: mul(this.matrix, shape.matrix),
					firstCommand: shape.firstCommand + this.commandBase,
					firstCoord: shape.firstCoord + this.coordBase
				}))

				mapped = this.target.clip(
					mul(this.matrix, clip.matrix),
					clip.firstCommand + this.commandBase,
					clip.firstCoord + this.coordBase,
					clip.evenOdd,
					clip.parent >= 0 && clip.parent < index ? this.clip(clip.parent) : this.parentClip,
					clip.commandCount,
					{
						...(shapes === undefined ? {} : { shapes }),
						...(clip.add === undefined ? {} : { add: clip.add.map(earlier), subtract: (clip.subtract ?? []).map(earlier) }),
						...(clip.opacity === undefined ? {} : { opacity: clip.opacity })
					}
				)
			}

			this.clips.set(index, mapped)
		}

		return mapped
	}

	// The source item's first command and coordinate in the target.
	pathStart(item: number): [number, number] {
		return [
			this.source.itemInt(item, ItemInt.FIRST_COMMAND) + this.commandBase,
			this.source.itemInt(item, ItemInt.FIRST_COORD) + this.coordBase
		]
	}

	copy(item: number): number {
		const source = this.source
		const f = item * ITEM_FLOATS
		const floats = source.itemFloats
		const kind = source.kind(item)
		const ref = source.itemInt(item, ItemInt.REF)
		let targetRef = -1

		if (kind === ItemKind.IMAGE) {
			targetRef = this.image(ref)
		} else if (kind === ItemKind.TEXT && ref >= 0) {
			const text: DrawingText | undefined = source.texts[ref]
			// A text's own paint is an index into the source's paints.
			const own =
				text !== undefined && (text.kind === "glyphs" || text.kind === "block") && text.fill !== undefined
					? { ...text, fill: this.paint(text.fill) }
					: text

			targetRef = own === undefined ? -1 : this.target.text(this.effect === undefined ? own : effectText(own, this.effect))
		}

		const [firstCommand, firstCoord] = this.pathStart(item)
		const copied = this.target.addItem(
			kind,
			mul(this.matrix, [
				floats[f] ?? 1,
				floats[f + 1] ?? 0,
				floats[f + 2] ?? 0,
				floats[f + 3] ?? 1,
				floats[f + 4] ?? 0,
				floats[f + 5] ?? 0
			]),
			floats[f + ItemFloat.X] ?? 0,
			floats[f + ItemFloat.Y] ?? 0,
			floats[f + ItemFloat.WIDTH] ?? 0,
			floats[f + ItemFloat.HEIGHT] ?? 0,
			firstCommand,
			firstCoord,
			this.paint(source.itemInt(item, ItemInt.FILL)),
			this.stroke(source.itemInt(item, ItemInt.STROKE)),
			targetRef,
			this.shadow(source.itemInt(item, ItemInt.SHADOW)),
			source.itemInt(item, ItemInt.FLAGS),
			source.itemInt(item, ItemInt.SOURCE),
			source.itemInt(item, ItemInt.COMMAND_COUNT)
		)

		this.target.setItemClip(copied, this.clip(source.itemClip(item)))

		return copied
	}
}

// Whether a drawing shows a metafile image (one an expansion would replace).
export function hasMetafileImages(list: DrawingList): boolean {
	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.IMAGE || (list.itemInt(item, ItemInt.FLAGS) & ItemFlag.HIDDEN) !== 0) continue

		const image = list.images[list.itemInt(item, ItemInt.REF)]

		if (image?.handling === "metafile" && image.partName !== undefined) return true
	}

	return false
}

// The list with each metafile image item replaced by its conversion (an image whose conversion fails stays
// as it is, drawn as a placeholder; an empty picture leaves nothing). The input list is returned unchanged
// when nothing converts. `starts`, when given (itemCount + 1 long), receives each input item's first item in the
// output (its end: the next one's), so positions recorded against the input carry over.
export async function expandMetafiles(
	list: DrawingList,
	convert: (image: DrawingImage) => Promise<MetafileConversion | undefined>,
	starts?: Int32Array
): Promise<DrawingList> {
	if (!hasMetafileImages(list)) {
		if (starts !== undefined) for (let item = 0; item <= list.itemCount && item < starts.length; item++) starts[item] = item

		return list
	}

	const conversions = new Map<number, MetafileConversion | undefined>()

	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.IMAGE || (list.itemInt(item, ItemInt.FLAGS) & ItemFlag.HIDDEN) !== 0) continue

		const ref = list.itemInt(item, ItemInt.REF)
		const image = list.images[ref]

		if (image === undefined || image.handling !== "metafile" || image.partName === undefined || conversions.has(ref)) continue

		conversions.set(ref, await convert(image))
	}

	let any = false

	for (const conversion of conversions.values()) if (conversion?.ok === true) any = true

	if (!any) {
		if (starts !== undefined) for (let item = 0; item <= list.itemCount && item < starts.length; item++) starts[item] = item

		return list
	}

	const out = new DrawingList()

	out.width = list.width
	out.height = list.height

	const host = new ListCopier(out, list, [1, 0, 0, 1, 0, 0], -1)
	let pixels = MAX_TOTAL_DECODE_PIXELS
	const budget: PixelBudget = {
		spend: count => {
			if (!(count >= 0) || count > pixels) return false

			pixels -= count

			return true
		}
	}

	for (let item = 0; item < list.itemCount; item++) {
		if (starts !== undefined && item < starts.length) starts[item] = out.itemCount

		const ref = list.kind(item) === ItemKind.IMAGE ? list.itemInt(item, ItemInt.REF) : -1
		const conversion = ref >= 0 && (list.itemInt(item, ItemInt.FLAGS) & ItemFlag.HIDDEN) === 0 ? conversions.get(ref) : undefined
		const image = ref >= 0 ? list.images[ref] : undefined

		if (conversion === undefined || !conversion.ok || image === undefined) {
			host.copy(item)
			continue
		}

		// An empty picture (an empty equation) draws nothing.
		if (conversion.list.itemCount > 0) embed(out, list, item, image, conversion, host, budget)
	}

	if (starts !== undefined && list.itemCount < starts.length) starts[list.itemCount] = out.itemCount

	return out
}

function embed(
	out: DrawingList,
	list: DrawingList,
	item: number,
	image: DrawingImage,
	conversion: Extract<MetafileConversion, { ok: true }>,
	host: ListCopier,
	budget: PixelBudget
): void {
	const f = item * ITEM_FLOATS
	const floats = list.itemFloats
	const itemMatrix = [floats[f] ?? 1, floats[f + 1] ?? 0, floats[f + 2] ?? 0, floats[f + 3] ?? 1, floats[f + 4] ?? 0, floats[f + 5] ?? 0]
	const x = floats[f + ItemFloat.X] ?? 0
	const y = floats[f + ItemFloat.Y] ?? 0
	const w = floats[f + ItemFloat.WIDTH] ?? 0
	const h = floats[f + ItemFloat.HEIGHT] ?? 0
	const [fx, fy, fw, fh] = conversion.frame
	const crop = image.crop
	const sw = fw * (1 - crop.left - crop.right)
	const sh = fh * (1 - crop.top - crop.bottom)

	if (!(w > 0 && h > 0 && sw > 0 && sh > 0)) return

	const sx = fx + crop.left * fw
	const sy = fy + crop.top * fh
	const placement = mul(itemMatrix, [w / sw, 0, 0, h / sh, x - (sx * w) / sw, y - (sy * h) / sh])
	// The picture is clipped to its box, or to its geometry when it has one, and by the item's own clip.
	const parent = host.clip(list.itemClip(item))
	const pathCount = list.itemInt(item, ItemInt.COMMAND_COUNT)
	// The picture's transparency applies to the drawing as a whole.
	const opacity = image.alpha < 1 && image.alpha >= 0 ? { opacity: image.alpha } : {}
	let clip: number

	if (pathCount > 0) {
		const [firstCommand, firstCoord] = host.pathStart(item)

		clip = out.clip(
			itemMatrix,
			firstCommand,
			firstCoord,
			(list.itemInt(item, ItemInt.FLAGS) & ItemFlag.EVEN_ODD) !== 0,
			parent,
			pathCount,
			opacity
		)
	} else {
		const firstCommand = out.commandCount
		const firstCoord = out.coordCount

		out.moveTo(x, y)
		out.lineTo(x + w, y)
		out.lineTo(x + w, y + h)
		out.lineTo(x, y + h)
		out.close()
		clip = out.clip(itemMatrix, firstCommand, firstCoord, false, parent, out.commandCount - firstCommand, opacity)
	}

	const source = list.itemInt(item, ItemInt.SOURCE)

	surface(out, conversion, placement, clip, source, image)

	const copier = new ListCopier(out, conversion.list, placement, clip, image, budget)

	for (let k = 0; k < conversion.list.itemCount; k++) {
		const copied = copier.copy(k)

		// Items keep the picture's source id, for hit testing.
		out.itemInts[copied * ITEM_INTS + ItemInt.SOURCE] = source
	}
}

// Draws a converted metafile into playback output: `matrix` maps the conversion's list space to output
// space; the drawing is clipped to its frame and by `clip`.
export function appendConversion(
	out: Output,
	conversion: Extract<MetafileConversion, { ok: true }>,
	matrix: Matrix,
	clip: ClipNode | null
): void {
	if (conversion.list.itemCount === 0 || clip?.hidesAll === true) return

	const list = out.list
	const parent = out.clip(clip)
	const [x, y, w, h] = conversion.frame
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(x, y)
	list.lineTo(x + w, y)
	list.lineTo(x + w, y + h)
	list.lineTo(x, y + h)
	list.close()

	const frameClip = list.clip(matrix, firstCommand, firstCoord, false, parent)

	surface(list, conversion, matrix, frameClip, 0)

	const copier = new ListCopier(list, conversion.list, matrix, frameClip)

	for (let k = 0; k < conversion.list.itemCount; k++) copier.copy(k)

	out.unsupported += conversion.unsupported
}

// The surface a conversion starts on (white under raster operations), as a frame-sized item under it.
function surface(
	out: DrawingList,
	conversion: Extract<MetafileConversion, { ok: true }>,
	matrix: Matrix,
	clip: number,
	source: number,
	picture?: DrawingImage
): void {
	const background = conversion.list.background

	if (background === undefined) return

	const effect = picture === undefined ? undefined : pictureEffect(picture)
	const [x, y, w, h] = conversion.frame
	const firstCommand = out.commandCount
	const firstCoord = out.coordCount

	out.moveTo(x, y)
	out.lineTo(x + w, y)
	out.lineTo(x + w, y + h)
	out.lineTo(x, y + h)
	out.close()

	const item = out.addItem(
		ItemKind.PATH,
		matrix,
		x,
		y,
		w,
		h,
		firstCommand,
		firstCoord,
		out.paint({ kind: "solid", color: effect === undefined ? background : effect(background) }),
		-1,
		-1,
		-1,
		0,
		source
	)

	out.setItemClip(item, clip)
}
