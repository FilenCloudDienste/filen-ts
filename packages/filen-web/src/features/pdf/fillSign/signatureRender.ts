import { OFFICE_FONT_URLS } from "virtual:office-fonts"
import type { PdfSignatureImage } from "@filen/office/core/pdfedit/visualSignature"
import { PDF_SIGNATURE_MAX_PNG_BYTES } from "@filen/shared/pdfSignatures"
import { extensionOf, HEIC_EXTENSIONS } from "@/features/drive/lib/preview.logic"
import { transformHeicBytesOwned } from "@/features/preview/lib/heicTransform"
import {
	needsSignatureFallback,
	SIGNATURE_FALLBACK_FAMILY,
	signatureFontFamily,
	signatureStyleFamily,
	signatureStyleFont,
	type SignatureStyle
} from "@/features/pdf/fillSign/signatureStyles"

// The signature dialog's drawing and encoding (plain functions, off the components): strokes on a canvas and as an
// SVG path, a typed name rendered in a handwriting style, a picked image turned into a small PNG.

// The ink of drawn and typed signatures (Fill & Sign's default, PDF_FILL_DEFAULT_INK).
export const SIGNATURE_INK = "rgb(13 26 89)"
// The fallback for characters the handwriting styles lack: the office set's calligraphic italic.
const FALLBACK_FONT_FILE = "gelasio/Gelasio-Italic-VF.woff2"
// A typed signature is drawn at this size (CSS px) before cropping: sharp at any placed size.
const TYPED_FONT_PX = 120
// The widest draft a typed signature is drawn on.
const TYPED_MAX_SIDE = 4000
// The longest side of an image signature; larger pictures are scaled down.
const IMAGE_MAX_SIDE = 1200

const fontLoads = new Map<string, Promise<void>>()

// Fetches a face once (HTTP-cached) and registers it for the page and its canvases. A failure is not cached.
function loadFace(family: string, url: string | undefined, unicodeRange?: string): Promise<void> {
	const cached = fontLoads.get(family)

	if (cached !== undefined) return cached
	if (url === undefined) return Promise.reject(new Error(`${family} missing`))

	const load = new FontFace(family, `url(${JSON.stringify(url)}) format("woff2")`, unicodeRange === undefined ? {} : { unicodeRange })
		.load()
		.then(face => {
			document.fonts.add(face)
		})
		.catch((error: unknown) => {
			fontLoads.delete(family)

			throw error
		})

	fontLoads.set(family, load)

	return load
}

// Registers the faces of `styles`, and the fallback when asked (only text with a character a style lacks needs it).
// The dialog loads every style (its previews show them all) the first time the Type tab opens.
export async function loadSignatureFonts(styles: readonly SignatureStyle[], fallback: boolean): Promise<void> {
	const loads = styles.map(style => {
		const font = signatureStyleFont(style)

		return loadFace(signatureStyleFamily(style), font.url, font.unicodeRange)
	})

	if (fallback) loads.push(loadFace(SIGNATURE_FALLBACK_FAMILY, OFFICE_FONT_URLS[FALLBACK_FONT_FILE]))

	await Promise.all(loads)
}

// Strokes (flat x, y runs) as one SVG path, for thumbnails.
export function strokesPath(strokes: readonly (readonly number[])[]): string {
	return strokes
		.map(stroke => {
			let path = `M${String(stroke[0] ?? 0)} ${String(stroke[1] ?? 0)}`

			// A single point draws as a dot.
			if (stroke.length === 2) return `${path}h0.01`

			for (let index = 2; index + 1 < stroke.length; index += 2) path += `L${String(stroke[index])} ${String(stroke[index + 1])}`

			return path
		})
		.join("")
}

// Draws strokes (CSS px) onto a context already scaled to CSS px.
export function drawStrokes(context: CanvasRenderingContext2D, strokes: readonly (readonly number[])[], lineWidth: number): void {
	context.lineCap = "round"
	context.lineJoin = "round"
	context.lineWidth = lineWidth
	context.strokeStyle = SIGNATURE_INK

	for (const stroke of strokes) {
		context.beginPath()
		context.moveTo(stroke[0] ?? 0, stroke[1] ?? 0)

		if (stroke.length === 2) context.lineTo((stroke[0] ?? 0) + 0.01, stroke[1] ?? 0)

		for (let index = 2; index + 1 < stroke.length; index += 2) context.lineTo(stroke[index] ?? 0, stroke[index + 1] ?? 0)

		context.stroke()
	}
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => {
			if (blob === null) reject(new Error("canvas could not be encoded"))
			else resolve(blob)
		}, "image/png")
	})
}

async function png(canvas: HTMLCanvasElement): Promise<PdfSignatureImage> {
	const bytes = new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer())

	return { kind: "image", png: bytes, width: canvas.width, height: canvas.height }
}

// The bounding box of the opaque pixels of a canvas, or null when it is empty.
function inkBounds(
	context: CanvasRenderingContext2D,
	width: number,
	height: number
): { x: number; y: number; width: number; height: number } | null {
	const pixels = context.getImageData(0, 0, width, height).data
	let minX = width
	let minY = height
	let maxX = -1
	let maxY = -1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 8) {
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}
		}
	}

	return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// A typed name in a handwriting style as a transparent PNG cropped to its ink (so it shows the same in every PDF
// viewer, no font embedded); null for empty text.
export async function renderTypedSignature(text: string, style: SignatureStyle): Promise<PdfSignatureImage | null> {
	const trimmed = text.trim()

	if (trimmed === "") return null

	await loadSignatureFonts([style], needsSignatureFallback(trimmed, style))

	const measure = document.createElement("canvas").getContext("2d")

	if (measure === null) throw new Error("no 2d context")

	// Script faces swash past their advance and line box: the draft holds the ink's measured box (at least the em),
	// scaled down when a long name would pass the widest canvas.
	const box = (px: number) => {
		measure.font = `${String(px)}px ${signatureFontFamily(style)}`

		const metrics = measure.measureText(trimmed)
		const left = Math.ceil(Math.max(0, metrics.actualBoundingBoxLeft))
		const ascent = Math.ceil(Math.max(px, metrics.actualBoundingBoxAscent))
		const pad = Math.round(px * 0.1)

		return {
			px,
			pad,
			left,
			ascent,
			width: left + Math.ceil(Math.max(metrics.width, metrics.actualBoundingBoxRight)) + pad * 2,
			height: ascent + Math.ceil(Math.max(px * 0.5, metrics.actualBoundingBoxDescent)) + pad * 2
		}
	}
	const natural = box(TYPED_FONT_PX)
	const fit = Math.min(1, TYPED_MAX_SIDE / natural.width, TYPED_MAX_SIDE / natural.height)
	const draw = fit < 1 ? box(Math.max(8, Math.floor(TYPED_FONT_PX * fit))) : natural
	const width = Math.min(TYPED_MAX_SIDE, draw.width)
	const height = Math.min(TYPED_MAX_SIDE, draw.height)
	const draft = document.createElement("canvas")

	draft.width = width
	draft.height = height

	const context = draft.getContext("2d", { willReadFrequently: true })

	if (context === null) throw new Error("no 2d context")

	context.font = measure.font
	context.fillStyle = SIGNATURE_INK
	context.textBaseline = "alphabetic"
	context.fillText(trimmed, draw.pad + draw.left, draw.pad + draw.ascent)

	const bounds = inkBounds(context, width, height)

	if (bounds === null) return null

	const margin = Math.round(TYPED_FONT_PX * 0.05)
	const output = document.createElement("canvas")

	output.width = bounds.width + margin * 2
	output.height = bounds.height + margin * 2
	output.getContext("2d")?.drawImage(draft, bounds.x, bounds.y, bounds.width, bounds.height, margin, margin, bounds.width, bounds.height)

	return png(output)
}

// A picture from the device as a PNG of at most IMAGE_MAX_SIDE px a side and PDF_SIGNATURE_MAX_PNG_BYTES (scaled down
// further until it fits). HEIC/HEIF is decoded by the HEIC worker first. Throws for anything that is not a readable
// image.
export async function imageFileSignature(file: File): Promise<PdfSignatureImage> {
	const source: Blob = HEIC_EXTENSIONS.has(extensionOf(file.name))
		? await transformHeicBytesOwned(new Uint8Array(await file.arrayBuffer()))
		: file
	const bitmap = await createImageBitmap(source)

	try {
		for (let side = IMAGE_MAX_SIDE; ; side = Math.round(side * 0.7)) {
			const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
			const canvas = document.createElement("canvas")

			canvas.width = Math.max(1, Math.round(bitmap.width * scale))
			canvas.height = Math.max(1, Math.round(bitmap.height * scale))
			canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

			const image = await png(canvas)

			if (image.png.byteLength <= PDF_SIGNATURE_MAX_PNG_BYTES) return image
			if (side <= 200) throw new Error("image too detailed")
		}
	} finally {
		bitmap.close()
	}
}
