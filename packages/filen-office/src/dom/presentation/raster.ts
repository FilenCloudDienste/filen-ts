import { EMU_PER_PX } from "../../core/drawingml/index"
import type { FontHost } from "../../core/fonts/index"
import { writeZip, type ByteSink, type Slicing } from "../../core/opc/index"
import type { PdfDeflate, PdfImageDecoder } from "../../core/pdfwrite/index"
import type { PdfFontAssets } from "../../core/pdfwrite/fonts/index"
import type { SlideRender } from "../../core/presentation/output"
import type { DocxFontFace } from "../docx/protocol"
import type { RasterCanvas, RealmCanvas } from "./services"
import { decodeSlidePictures, paintSlideCanvas } from "./thumbs"

// The raster side of exports: a slide painted on a canvas of the width asked (the thumbnails' painter, at full size)
// and encoded as PNG or JPEG; several as a stored zip (PNG and JPEG are compressed already), each image written into
// it and let go before the next is painted. And what a jobs worker's realm gives the export jobs.

// Widths an image export makes (px).
export const MIN_EXPORT_WIDTH = 16
export const MAX_EXPORT_WIDTH = 8192
export const DEFAULT_EXPORT_WIDTH = 1920

// What a jobs worker's realm serves its jobs: the PDF faces, canvases and the font host the raster path draws text
// with, the app's language (a tagged PDF names one), and how the worker yields.
export interface JobsRealm {
	readonly assets: PdfFontAssets
	readonly canvas?: RealmCanvas
	readonly fonts?: FontHost
	readonly lang?: string
	readonly slicing?: Slicing
	readonly deflate?: PdfDeflate | null
	readonly decoder?: PdfImageDecoder
}

let jobsRealm: JobsRealm | undefined

export function installJobsRealm(realm: JobsRealm | undefined): void {
	jobsRealm = realm
}

export function presentationJobsRealm(): JobsRealm | undefined {
	return jobsRealm
}

// Registers the session's faces with `host` (once per alias, weight and style), so the canvas draws the faces the
// text was laid out in.
export async function registerFaces(host: FontHost, faces: readonly DocxFontFace[], done: Set<string> = new Set()): Promise<void> {
	for (const face of faces) {
		const key = `${face.face.family}|${String(face.face.weight)}|${face.face.italic ? 1 : 0}`

		if (done.has(key)) continue

		done.add(key)

		if (face.kind === "bytes") await host.addBytes(face.face, face.bytes)
		else await host.addLocal(face.face, face.name)
	}
}

export type RasterFormat = "png" | "jpeg"

interface EncodingCanvas extends RasterCanvas {
	convertToBlob(options: { readonly type: string; readonly quality?: number }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
}

function canEncode(canvas: RasterCanvas): canvas is EncodingCanvas {
	return typeof Reflect.get(canvas, "convertToBlob") === "function"
}

export interface SlideImageOptions {
	readonly canvas: RealmCanvas
	// Deck size (EMU).
	readonly size: { readonly cx: number; readonly cy: number }
	readonly widthPx: number
	readonly format: RasterFormat
	// JPEG, 0..1.
	readonly quality?: number
	readonly read: (part: string) => Promise<Uint8Array | null>
}

// The pixel size of a slide image `widthPx` wide (its height from the deck's proportions), held to the canvas limits.
export function exportSize(size: { readonly cx: number; readonly cy: number }, widthPx: number): { width: number; height: number } {
	const slideWidth = Math.max(1, size.cx / EMU_PER_PX)
	const slideHeight = Math.max(1, size.cy / EMU_PER_PX)
	let width = Math.round(
		Math.min(MAX_EXPORT_WIDTH, Math.max(MIN_EXPORT_WIDTH, Number.isFinite(widthPx) ? widthPx : DEFAULT_EXPORT_WIDTH))
	)
	let height = Math.max(1, Math.round((width * slideHeight) / slideWidth))

	// A very tall deck: the height is held to the same limit, the width following.
	if (height > MAX_EXPORT_WIDTH) {
		height = MAX_EXPORT_WIDTH
		width = Math.max(1, Math.round((height * slideWidth) / slideHeight))
	}

	return { width, height }
}

// A slide as an encoded image; undefined where the realm has no canvas of that size or cannot encode.
export async function slideImage(render: SlideRender, options: SlideImageOptions): Promise<Uint8Array | undefined> {
	const { width, height } = exportSize(options.size, options.widthPx)
	const canvas = options.canvas.canvas(width, height)
	const ctx = canvas?.getContext("2d") ?? null

	if (canvas === undefined || ctx === null || !canEncode(canvas)) return undefined

	const pictures = await decodeSlidePictures(
		render,
		{ canvas: options.canvas, size: options.size, widthPx: width, read: options.read },
		Math.min(4096, width * 2)
	)

	try {
		ctx.fillStyle = "#ffffff"
		ctx.fillRect(0, 0, width, height)
		paintSlideCanvas(ctx, render, width / Math.max(1, options.size.cx / EMU_PER_PX), pictures.images)
	} finally {
		pictures.release()
	}

	const type = options.format === "jpeg" ? "image/jpeg" : "image/png"
	const blob = await canvas.convertToBlob(
		options.format === "jpeg" ? { type, quality: Math.min(1, Math.max(0, options.quality ?? 0.92)) } : { type }
	)

	return new Uint8Array(await blob.arrayBuffer())
}

// The name of a slide's image in an export: "Slide<n>.png" (n from 1, as the slide's place in the deck).
export function slideImageName(index: number, format: RasterFormat): string {
	return `Slide${String(index + 1)}.${format === "jpeg" ? "jpg" : "png"}`
}

// Images written as a stored zip into `sink`, each made when the writer asks for it.
export async function writeImageZip(
	images: AsyncIterable<{ readonly name: string; readonly bytes: Uint8Array }>,
	sink: ByteSink,
	options: { readonly slicing?: Slicing; readonly modified?: Date } = {}
): Promise<number> {
	const modified = options.modified ?? new Date()

	async function* items() {
		for await (const image of images) yield { kind: "data" as const, name: image.name, bytes: image.bytes, compress: false, modified }
	}

	let size = 0
	const counting: ByteSink = {
		write: chunk => {
			size += chunk.length

			return sink.write(chunk)
		},
		close: () => sink.close()
	}

	await writeZip({ items: items() }, null, counting, options.slicing === undefined ? {} : { slicing: options.slicing })

	return size
}
