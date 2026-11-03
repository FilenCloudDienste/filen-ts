import { ITEM_FLOATS, ITEM_INTS, ItemFloat, ItemInt, type DrawingList, type ImageTile } from "../../drawingml/displayList"
import { MAX_IMAGE_BYTES, sniffImage } from "../../docx/objects/images"
import { MetafileCache } from "../../metafile/cache"
import { MAX_METAFILE_BYTES, expandMetafiles, hasMetafileImages } from "../../metafile/index"
import { convertPresentationMetafile } from "../../metafile/legacy"
import type { RenderReport } from "./effects"
import type { RenderServices } from "./services"

// What a layer's pictures need from their bytes, once the drawing is converted:
// - EMF, WMF, SVM and PICT pictures (pictures, OLE previews, media posters) drawn as what they hold: each metafile image item is
//   replaced by its conversion (core/metafile, as the docx and xlsx drawings do). Conversions are kept per host (logos
//   repeat on every slide), bounded by core/metafile's cache.
// - Tiled picture fills (a:tile, ECMA-376 §20.1.8.58) placed at the picture's own size: its pixels at its resolution
//   (96 dpi when it states none), scaled by sx/sy, aligned in the filled box by algn and offset by tx/ty, repeated.

const caches = new WeakMap<RenderServices, MetafileCache>()
const sizes = new WeakMap<RenderServices, Map<string, Promise<{ readonly width: number; readonly height: number } | undefined>>>()
// The names of cached conversions' embedded bitmaps (weak: a conversion the cache drops takes its names along).
const bitmapNames = new WeakMap<Uint8Array, string>()
let bitmapCount = 0
// Tiled pictures whose sizes are kept per host.
const MAX_SIZES = 256
const PX_PER_INCH = 96

function cacheOf(services: RenderServices, read: NonNullable<RenderServices["bytes"]>): MetafileCache {
	let cache = caches.get(services)

	if (cache === undefined) {
		cache = new MetafileCache(async part => {
			let bytes: Uint8Array | undefined

			// An unreadable part is a picture that does not convert (a placeholder, counted), not a failed slide.
			try {
				bytes = await read(part, MAX_METAFILE_BYTES)
			} catch {
				return undefined
			}

			return bytes === undefined || bytes.length > MAX_METAFILE_BYTES ? undefined : convertPresentationMetafile(bytes)
		})
		caches.set(services, cache)
	}

	return cache
}

export interface FinishedLayer {
	readonly list: DrawingList
	// Per item of the input list (itemCount + 1 entries), its first item in `list`; undefined when nothing changed.
	readonly starts: Int32Array | undefined
}

// `list` with its metafile pictures converted. A picture that does not convert stays a placeholder and is counted
// ("metafile"); without a byte reader every one is.
async function expandMetafilePictures(list: DrawingList, services: RenderServices, report: RenderReport): Promise<FinishedLayer> {
	if (!hasMetafileImages(list)) return { list, starts: undefined }

	const read = services.bytes

	if (read === undefined) {
		report.refuse("metafile:noReader")

		return { list, starts: undefined }
	}

	const cache = cacheOf(services, read.bind(services))
	const starts = new Int32Array(list.itemCount + 1)
	let expanded: DrawingList

	try {
		expanded = await expandMetafiles(list, image => cache.get(image.partName), starts)
	} catch {
		report.refuse("metafile:failed")

		return { list, starts: undefined }
	}

	if (hasMetafileImages(expanded)) report.refuse("metafile")
	if (expanded === list) return { list, starts: undefined }

	// Each embedded bitmap is named by the cached conversion's array it comes from, so the page keys every copy of it
	// alike (one blob URL per bitmap across slide views) without reading its bytes.
	expanded.images.forEach((image, index) => {
		if (image.bytes === undefined || image.partName !== undefined) return

		let name = bitmapNames.get(image.bytes)

		if (name === undefined) {
			name = String(++bitmapCount)
			bitmapNames.set(image.bytes, name)
		}

		expanded.images[index] = { ...image, bytesKey: name }
	})

	// The arrays a conversion's tables hold (embedded bitmaps, gradient stops, meshes, dashes, glyph positions) belong to
	// the cached conversion, and a render's buffers are transferred to the page: each render sends its own copies.
	for (const table of [
		expanded.images,
		expanded.paints,
		expanded.strokes,
		expanded.texts,
		expanded.shadows,
		expanded.clips
	] as unknown[][])
		table.forEach((entry, index) => {
			table[index] = ownArrays(entry, 0)
		})

	return { list: expanded, starts }
}

// `value` with each typed array it reaches copied (objects and arrays rebuilt along the way, nothing else).
function ownArrays(value: unknown, depth: number): unknown {
	if (ArrayBuffer.isView(value)) return value instanceof DataView ? new DataView(value.buffer.slice(0)) : (value as Uint8Array).slice()
	if (typeof value !== "object" || value === null || depth > 8) return value
	if (Array.isArray(value)) return value.map(item => ownArrays(item, depth + 1))

	const out: Record<string, unknown> = {}

	for (const [key, item] of Object.entries(value)) out[key] = ownArrays(item, depth + 1)

	return out
}

// A picture's size as drawn at 100%, in px (the slide's 96 per inch).
function pictureSize(
	services: RenderServices,
	read: NonNullable<RenderServices["bytes"]>,
	part: string
): Promise<{ readonly width: number; readonly height: number } | undefined> {
	let held = sizes.get(services)

	if (held === undefined) {
		held = new Map()
		sizes.set(services, held)
	}

	const cached = held.get(part)

	if (cached !== undefined) return cached

	const size = (async () => {
		try {
			const bytes = await read(part, MAX_IMAGE_BYTES)
			const info = bytes === undefined ? undefined : sniffImage(bytes)

			return info === undefined || typeof info === "string"
				? undefined
				: { width: (info.width * PX_PER_INCH) / info.dpiX, height: (info.height * PX_PER_INCH) / info.dpiY }
		} catch {
			return undefined
		}
	})()

	if (held.size >= MAX_SIZES)
		for (const oldest of held.keys()) {
			held.delete(oldest)
			break
		}

	held.set(part, size)

	return size
}

// The tile's origin in the box: the tile placed at the alignment point (§20.1.10.3 ST_RectAlignment), then offset.
function tileOrigin(tile: ImageTile, x: number, y: number, w: number, h: number, tw: number, th: number): [number, number] {
	const column =
		tile.align === "tl" || tile.align === "l" || tile.align === "bl"
			? 0
			: tile.align === "tr" || tile.align === "r" || tile.align === "br"
				? 1
				: 0.5
	const row =
		tile.align === "tl" || tile.align === "t" || tile.align === "tr"
			? 0
			: tile.align === "bl" || tile.align === "b" || tile.align === "br"
				? 1
				: 0.5

	return [x + (w - tw) * column + tile.tx, y + (h - th) * row + tile.ty]
}

// Each item filled with an implicit tile gets an explicit one for its own box; a picture whose size is unknown keeps
// the implicit tile (drawn stretched) and is counted.
async function placeTiles(list: DrawingList, services: RenderServices, report: RenderReport): Promise<void> {
	const read = services.bytes
	const tiled: number[] = []

	for (let item = 0; item < list.itemCount; item++) {
		const paint = list.paints[list.itemInt(item, ItemInt.FILL)]

		if (paint?.kind === "image" && paint.tile !== undefined && paint.tile.width === undefined) tiled.push(item)
	}

	if (tiled.length === 0) return

	if (read === undefined) {
		report.approximate("tile:noReader", tiled.length)

		return
	}

	for (const item of tiled) {
		const paint = list.paints[list.itemInt(item, ItemInt.FILL)]

		if (paint?.kind !== "image" || paint.tile === undefined) continue

		const image = list.images[paint.image]
		const part = image?.partName
		const size = part === undefined || image?.handling !== "native" ? undefined : await pictureSize(services, read.bind(services), part)

		if (size === undefined || !(size.width > 0 && size.height > 0)) {
			report.approximate("tile:size")
			continue
		}

		const tile = paint.tile
		const f = item * ITEM_FLOATS
		const tw = size.width * Math.abs(tile.sx)
		const th = size.height * Math.abs(tile.sy)

		if (!(tw > 0 && th > 0)) continue

		const [ox, oy] = tileOrigin(
			tile,
			list.itemFloats[f + ItemFloat.X] ?? 0,
			list.itemFloats[f + ItemFloat.Y] ?? 0,
			list.itemFloats[f + ItemFloat.WIDTH] ?? 0,
			list.itemFloats[f + ItemFloat.HEIGHT] ?? 0,
			tw,
			th
		)
		const explicit: ImageTile = { ...tile, width: tw, height: th, matrix: [1, 0, 0, 1, ox, oy] }

		list.itemInts[item * ITEM_INTS + ItemInt.FILL] = list.paint({ ...paint, tile: explicit })
	}
}

// A layer's drawing with its metafile pictures converted and its tiles placed. `starts` maps the input's items to
// the output's when the items moved.
export async function finishPictures(list: DrawingList, services: RenderServices, report: RenderReport): Promise<FinishedLayer> {
	const expanded = await expandMetafilePictures(list, services, report)

	await placeTiles(expanded.list, services, report)

	return expanded
}
