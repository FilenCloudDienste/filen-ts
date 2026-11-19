import { Unzlib } from "fflate"
import type { DrawingImage, DrawingText, GradientStops, Paint, Rgba, TextRun } from "../drawingml/displayList"
import { decodeDib, encodePng, parseDib, type PixelBudget } from "./dib"
import { Bytes } from "./bytes"
import { MAX_DECODE_PIXELS } from "./limits"

// A picture's effects (a:blip effects, v:imagedata adjustments) applied to the metafile drawn in its place:
// every colour of its vector content goes through the same chain the renderer applies to bitmaps
// (colour change, grey, brightness and contrast, bi-level, duotone); its embedded bitmaps take the effects
// as image fields; alpha becomes the group's opacity.

export type ColorEffect = (color: Rgba) => Rgba

const LUMA = [0.2126, 0.7152, 0.0722]

function channel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value * 255)))
}

// The chain for an image's effects, or undefined when it has none that change colours.
export function pictureEffect(image: DrawingImage): ColorEffect | undefined {
	const change = image.colorChange
	const gray = image.grayscale || image.biLevel >= 0 || image.duotone !== null
	const brightness = Number.isFinite(image.brightness) ? Math.max(-1, Math.min(1, image.brightness)) : 0
	const contrast = Number.isFinite(image.contrast) ? Math.max(-0.99, Math.min(0.99, image.contrast)) : 0

	if (change === null && !gray && brightness === 0 && contrast === 0) return undefined

	const slope = (1 + contrast) / (1 - contrast)
	const intercept = 0.5 - 0.5 * slope + brightness

	return color => {
		let rgba = color >>> 0

		if (change !== null && ((rgba >>> 8) & 0xffffff) === ((change[0] >>> 8) & 0xffffff)) rgba = change[1] >>> 0

		let r = (rgba >>> 24) / 255
		let g = ((rgba >>> 16) & 255) / 255
		let b = ((rgba >>> 8) & 255) / 255
		const a = rgba & 255

		if (gray) r = g = b = (LUMA[0] ?? 0) * r + (LUMA[1] ?? 0) * g + (LUMA[2] ?? 0) * b

		if (brightness !== 0 || contrast !== 0) {
			r = slope * r + intercept
			g = slope * g + intercept
			b = slope * b + intercept
		}

		if (image.biLevel >= 0) r = g = b = r < image.biLevel ? 0 : 1

		if (image.duotone !== null) {
			const [dark, light] = image.duotone
			const t = Math.max(0, Math.min(1, r))
			const mix = (shift: number): number => (((dark >>> shift) & 255) * (1 - t) + ((light >>> shift) & 255) * t) / 255

			r = mix(24)
			g = mix(16)
			b = mix(8)
		}

		return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | a) >>> 0
	}
}

function stops(value: GradientStops, effect: ColorEffect): GradientStops {
	return { offsets: value.offsets, colors: Uint32Array.from(value.colors, effect) }
}

export function effectPaint(paint: Paint, effect: ColorEffect): Paint {
	switch (paint.kind) {
		case "solid":
			return { ...paint, color: effect(paint.color) }
		case "linear":
		case "path":
		case "gradient":
			return { ...paint, stops: stops(paint.stops, effect) }
		case "pattern":
			return { ...paint, foreground: effect(paint.foreground), background: effect(paint.background) }
		case "image":
			return paint
		case "shaded": {
			const ramp = paint.ramp

			return {
				...paint,
				colors: Uint32Array.from(paint.colors, effect),
				ramp:
					ramp === null
						? null
						: {
								...ramp,
								center: effect(ramp.center),
								colors: ramp.colors === null ? null : Uint32Array.from(ramp.colors, effect)
							}
			}
		}
	}
}

function effectRun(run: TextRun, effect: ColorEffect): TextRun {
	return { ...run, color: effect(run.color) }
}

export function effectText(text: DrawingText, effect: ColorEffect): DrawingText {
	switch (text.kind) {
		case "glyphs":
		case "block":
			return { ...text, run: effectRun(text.run, effect) }
		case "body":
			return {
				...text,
				paragraphs: text.paragraphs.map(paragraph => ({ ...paragraph, runs: paragraph.runs.map(run => effectRun(run, effect)) }))
			}
		case "story":
			return text
	}
}

// Recoloured bitmaps per source bytes and colour change: a picture placed many times is recoloured once.
const recolourCache = new WeakMap<Uint8Array, Map<string, Uint8Array | null>>()

// An embedded bitmap with the picture's effects: the colour change applied to its pixels (a JPEG keeps
// its own, having no exact colours to match), the rest as fields the renderer applies.
export function effectImage(image: DrawingImage, picture: DrawingImage, budget: PixelBudget): DrawingImage {
	let bytes = image.bytes
	let format = image.format

	if (picture.colorChange !== null && bytes !== undefined && (format === "png" || format === "bmp")) {
		const [from, to] = picture.colorChange
		const key = `${from},${to}`
		let byChange = recolourCache.get(bytes)

		if (byChange === undefined) {
			byChange = new Map()
			recolourCache.set(bytes, byChange)
		}

		let recolouredBytes = byChange.get(key)

		if (recolouredBytes === undefined) {
			recolouredBytes = recolor(bytes, format, from, to, budget) ?? null
			byChange.set(key, recolouredBytes)
		}

		const recoloured = recolouredBytes ?? undefined

		if (recoloured !== undefined) {
			bytes = recoloured
			format = "png"
		}
	}

	return {
		...image,
		format,
		...(bytes === undefined ? {} : { bytes }),
		grayscale: image.grayscale || picture.grayscale,
		biLevel: picture.biLevel >= 0 ? picture.biLevel : image.biLevel,
		duotone: picture.duotone ?? image.duotone,
		brightness: Math.max(-1, Math.min(1, image.brightness + picture.brightness)),
		contrast: Math.max(-0.99, Math.min(0.99, image.contrast + picture.contrast))
	}
}

// Compressed bytes per inflate step (at most ~1032 times as much output).
const INFLATE_STEP = 8 * 1024

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c
	const pa = Math.abs(p - a)
	const pb = Math.abs(p - b)
	const pc = Math.abs(p - c)

	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// The pixels of an 8-bit RGBA or RGB, non-interlaced PNG, or undefined for any other.
function decodePng(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length < 33) return undefined

	const width = view.getUint32(16)
	const height = view.getUint32(20)
	const depth = bytes[24]
	const type = bytes[25]
	const channels = type === 6 ? 4 : type === 2 ? 3 : 0

	if (depth !== 8 || channels === 0 || bytes[28] !== 0 || width * height > MAX_DECODE_PIXELS || width === 0 || height === 0)
		return undefined

	const parts: Uint8Array[] = []
	let at = 8

	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at)
		const name = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0)

		if (at + 12 + length > bytes.length) return undefined
		if (name === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length))
		if (name === "IEND") break

		at += 12 + length
	}

	const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of parts) {
		joined.set(part, offset)
		offset += part.length
	}

	const stride = width * channels
	const raw = new Uint8Array((stride + 1) * height)
	let written = 0
	// fflate inflates all it is given before handing anything over, so the data goes in small steps and stops
	// once the declared rows are filled, however far the rest would expand.
	const unzlib = new Unzlib(chunk => {
		raw.set(chunk.subarray(0, raw.length - written), written)
		written += Math.min(chunk.length, raw.length - written)
	})

	try {
		for (let at = 0; at < joined.length && written < raw.length; at += INFLATE_STEP) {
			unzlib.push(joined.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= joined.length)
		}
	} catch {
		return undefined
	}

	const rgba = new Uint8Array(width * height * 4)
	const previous = new Uint8Array(stride)
	const current = new Uint8Array(stride)

	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1)
		const filter = raw[row] ?? 0

		for (let x = 0; x < stride; x++) {
			const value = raw[row + 1 + x] ?? 0
			const left = x >= channels ? (current[x - channels] ?? 0) : 0
			const up = previous[x] ?? 0
			const corner = x >= channels ? (previous[x - channels] ?? 0) : 0
			const predicted =
				filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0

			current[x] = (value + predicted) & 255
		}

		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4

			rgba[o] = current[x * channels] ?? 0
			rgba[o + 1] = current[x * channels + 1] ?? 0
			rgba[o + 2] = current[x * channels + 2] ?? 0
			rgba[o + 3] = channels === 4 ? (current[x * channels + 3] ?? 0) : 255
		}

		previous.set(current)
	}

	return { rgba, width, height }
}

// The bitmap with pixels of colour `from` turned `to` (alpha included), as PNG.
function recolor(bytes: Uint8Array, format: "png" | "bmp", from: Rgba, to: Rgba, budget: PixelBudget): Uint8Array | undefined {
	let decoded: { rgba: Uint8Array; width: number; height: number } | undefined

	if (format === "png") {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		// The declared size is paid for before anything is inflated.
		if (bytes.length < 24 || !budget.spend(view.getUint32(16) * view.getUint32(20))) return undefined

		decoded = decodePng(bytes)
	} else {
		const view = new Bytes(bytes)
		const dib = parseDib(view, 14, view.u32(10) - 14, view.u32(10), bytes.length - view.u32(10), 0)
		const rgba = dib === undefined ? undefined : decodeDib(dib, false, budget)

		decoded = dib === undefined || rgba === undefined ? undefined : { rgba, width: dib.width, height: dib.height }
	}

	if (decoded === undefined) return undefined

	const { rgba } = decoded

	for (let p = 0; p < rgba.length; p += 4) {
		if (rgba[p] === from >>> 24 && rgba[p + 1] === ((from >>> 16) & 255) && rgba[p + 2] === ((from >>> 8) & 255)) {
			rgba[p] = to >>> 24
			rgba[p + 1] = (to >>> 16) & 255
			rgba[p + 2] = (to >>> 8) & 255
			rgba[p + 3] = to & 255
		}
	}

	return encodePng(rgba, decoded.width, decoded.height)
}
