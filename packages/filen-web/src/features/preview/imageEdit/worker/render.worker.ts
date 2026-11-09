/// <reference lib="webworker" />
import { isWideGamutIcc } from "@/features/preview/imageEdit/lib/icc"
import * as Comlink from "comlink"
import { Semaphore } from "@filen/shared"
import type { ImageEditRecipe, ImageEditSource, MarkupItem, SourceInfo } from "@/features/preview/imageEdit/types"
import { effectiveAdjustments, FILTER_PRESETS } from "@/features/preview/imageEdit/lib/filters"
import { geometryMatrix, outputSize, sourceRectForTile } from "@/features/preview/imageEdit/lib/recipe"
import { canEncodeWebp, encodeImage, type ExportMeta } from "@/features/preview/imageEdit/worker/encoders"
import { loadMarkupFonts, markupFontsReady } from "@/features/preview/imageEdit/worker/markup"
import { ContextLostError, Renderer, type Frame, type SourcePixels } from "@/features/preview/imageEdit/worker/renderer"
import { log } from "@/lib/log"

// The image editor's render worker: one editing session at a time on the canvas the editor transferred, with the
// full-resolution original held here so neither the preview nor the export ever crosses back to the page.
// renderClient.ts owns its lifecycle.

const NO_MARKUP: readonly MarkupItem[] = []

interface Pending {
	recipe: ImageEditRecipe
	compare: boolean
}

interface Session {
	id: number
	canvas: OffscreenCanvas | null
	gl: WebGL2RenderingContext | null
	// Null while the context is lost: every GL object went with it.
	renderer: Renderer | null
	source: SourcePixels | null
	opaque: boolean
	// The source's profile is wider than sRGB: previewed on a Display P3 drawing buffer.
	wideGamut: boolean
	// The source the renderer's preview texture shows, and the build in flight.
	previewOf: SourcePixels | null
	building: { of: SourcePixels; renderer: Renderer; done: Promise<void> } | null
	latest: Pending | null
	frameQueued: boolean
}

let session: Session | null = null
let nextId = 1

// Exports one at a time: each holds a full-resolution RGBA buffer and an encoder's working copy.
const exportLock = new Semaphore(1)

const contextAttributes: WebGLContextAttributes = {
	alpha: true,
	premultipliedAlpha: true,
	antialias: false,
	depth: false,
	stencil: false,
	preserveDrawingBuffer: false
}

function current(id: number): Session {
	if (session?.id !== id) {
		throw new Error("image edit session closed")
	}

	return session
}

function frameOf(recipe: ImageEditRecipe, source: { width: number; height: number }, compare: boolean): Frame {
	const output = outputSize(recipe, source)
	const outputToSource = geometryMatrix(recipe, source)

	if (compare) {
		return { output, outputToSource, adjustA: [0, 0, 0, 0], adjustB: [0, 0, 0, 0], adjustC: [0, 0], sharpness: 0, markup: NO_MARKUP }
	}

	const a = effectiveAdjustments(recipe)

	return {
		output,
		outputToSource,
		adjustA: [a.exposure / 100, a.brightness / 100, a.contrast / 100, a.highlights / 100],
		adjustB: [a.shadows / 100, a.warmth / 100, a.tint / 100, a.saturation / 100],
		adjustC: [a.vibrance / 100, a.vignette / 100],
		sharpness: a.sharpness / 100,
		markup: recipe.markup
	}
}

// Dedicated workers draw on rAF where the engine has it (HTML § 8.10.1 for workers); a timer otherwise.
const scope: { requestAnimationFrame?: (callback: FrameRequestCallback) => number } = globalThis

function queueFrame(s: Session): void {
	if (s.frameQueued) {
		return
	}

	s.frameQueued = true

	const run = (): void => {
		s.frameQueued = false
		drawFrame(s)
	}

	if (scope.requestAnimationFrame === undefined) {
		setTimeout(run, 16)
	} else {
		scope.requestAnimationFrame(run)
	}
}

function drawFrame(s: Session): void {
	const { renderer, source, latest } = s

	if (session !== s || renderer === null || source === null || latest === null || s.previewOf !== source) {
		return
	}

	const frame = frameOf(latest.recipe, source, latest.compare)

	// Missing glyphs draw in the fallback face now and redraw once the face lands.
	markupFontsReady(frame.markup, () => {
		queueFrame(s)
	})
	renderer.drawPreview(frame, s.opaque)
}

// Builds the preview texture once a renderer and a source are both present, and redraws. A build overtaken by
// a newer source or a new context is thrown away rather than installed.
function ensurePreview(s: Session): Promise<void> {
	const { renderer, source } = s

	if (renderer === null || source === null || s.previewOf === source) {
		return Promise.resolve()
	}

	if (s.building?.of === source && s.building.renderer === renderer) {
		return s.building.done
	}

	const done = renderer.buildPreview(source).then(
		preview => {
			if (s.building?.done === done) {
				s.building = null
			}

			if (s.renderer !== renderer || s.source !== source) {
				renderer.discardPreview(preview)

				return
			}

			renderer.setPreview(preview)
			s.previewOf = source
			queueFrame(s)
		},
		(error: unknown) => {
			if (s.building?.done === done) {
				s.building = null
			}

			throw error
		}
	)

	s.building = { of: source, renderer, done }

	return done
}

// A context lost mid-build is rebuilt on restore (webglcontextrestored), so the caller is not failed for it.
function ignoreContextLoss(error: unknown): void {
	if (!(error instanceof ContextLostError)) {
		throw error
	}
}

function releaseContext(s: Session): void {
	s.renderer?.dispose()
	// Hands the GPU memory back now instead of whenever the context is collected (WEBGL_lose_context).
	s.gl?.getExtension("WEBGL_lose_context")?.loseContext()
	s.renderer = null
	s.gl = null
	s.previewOf = null
	s.building = null

	if (s.canvas !== null) {
		s.canvas.width = 1
		s.canvas.height = 1
		s.canvas = null
	}
}

function releaseSource(s: Session): void {
	if (s.source?.kind === "bitmap") {
		s.source.bitmap.close()
	}

	s.source = null
	s.previewOf = null
	s.building = null
}

function sizeCanvas(canvas: OffscreenCanvas, cssWidth: number, cssHeight: number, dpr: number): void {
	canvas.width = Math.max(1, Math.round(cssWidth * dpr))
	canvas.height = Math.max(1, Math.round(cssHeight * dpr))
}

// Preview only: the drawing buffer shows a wide-gamut source's raw values as Display P3 (Chrome 104, Firefox 132,
// Safari 16.4); an engine without the property keeps sRGB.
function applyColorSpace(s: Session): void {
	if (s.gl !== null && "drawingBufferColorSpace" in s.gl) {
		s.gl.drawingBufferColorSpace = s.wideGamut ? "display-p3" : "srgb"
	}
}

async function decode(source: ImageEditSource): Promise<SourcePixels> {
	switch (source.kind) {
		case "blob": {
			// Stored values as they are (the ICC profile travels separately), upright, straight alpha.
			const bitmap = await createImageBitmap(source.blob, {
				colorSpaceConversion: "none",
				imageOrientation: "from-image",
				premultiplyAlpha: "none"
			})

			return { kind: "bitmap", bitmap, width: bitmap.width, height: bitmap.height }
		}
		case "bitmap":
			return { kind: "bitmap", bitmap: source.bitmap, width: source.bitmap.width, height: source.bitmap.height }
		case "rgba":
			if (source.data.length < source.width * source.height * 4) {
				throw new Error("RGBA source shorter than its size")
			}

			return {
				kind: "rgba",
				data: new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
				width: source.width,
				height: source.height
			}
	}
}

const api = {
	async probe(): Promise<{ webgl2: boolean; maxTextureSize: number; canEncodeWebp: boolean }> {
		const webp = canEncodeWebp()
		const gl = new OffscreenCanvas(1, 1).getContext("webgl2")

		if (gl === null) {
			return { webgl2: false, maxTextureSize: 0, canEncodeWebp: await webp }
		}

		const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number

		gl.getExtension("WEBGL_lose_context")?.loseContext()

		return { webgl2: true, maxTextureSize, canEncodeWebp: await webp }
	},

	// A fresh session; one that was still open is closed first.
	open(): number {
		if (session !== null) {
			api.close(session.id)
		}

		session = {
			id: nextId++,
			canvas: null,
			gl: null,
			renderer: null,
			source: null,
			opaque: true,
			wideGamut: false,
			previewOf: null,
			building: null,
			latest: null,
			frameQueued: false
		}

		return session.id
	},

	async attach(id: number, canvas: OffscreenCanvas, cssWidth: number, cssHeight: number, dpr: number): Promise<void> {
		const s = current(id)

		releaseContext(s)
		sizeCanvas(canvas, cssWidth, cssHeight, dpr)

		const gl = canvas.getContext("webgl2", contextAttributes)

		if (gl === null) {
			throw new Error("WebGL 2 unavailable")
		}

		// Default handling of a lost context is to never restore it; preventing it asks for a restore, after which
		// everything is rebuilt from the held source (WebGL 1.0 §5.15.2).
		canvas.addEventListener("webglcontextlost", event => {
			event.preventDefault()

			if (s.gl === gl) {
				s.renderer = null
				s.previewOf = null
				s.building = null
			}
		})
		canvas.addEventListener("webglcontextrestored", () => {
			if (session !== s || s.gl !== gl) {
				return
			}

			s.renderer = new Renderer(gl)
			ensurePreview(s).catch((error: unknown) => {
				log.error("imageEdit", "preview rebuild after context restore failed", error)
			})
		})

		s.canvas = canvas
		s.gl = gl
		applyColorSpace(s)
		s.renderer = new Renderer(gl)

		await ensurePreview(s).catch(ignoreContextLoss)
	},

	resize(id: number, cssWidth: number, cssHeight: number, dpr: number): void {
		const s = current(id)

		if (s.canvas === null) {
			return
		}

		sizeCanvas(s.canvas, cssWidth, cssHeight, dpr)
		s.renderer?.releaseIntermediate()
		queueFrame(s)
	},

	async load(id: number, source: ImageEditSource, info: SourceInfo): Promise<{ width: number; height: number }> {
		const s = current(id)
		const pixels = await decode(source)

		if (session !== s) {
			if (pixels.kind === "bitmap") {
				pixels.bitmap.close()
			}

			throw new Error("image edit session closed")
		}

		releaseSource(s)
		s.source = pixels
		// The header's word, never a pixel scan: a source without alpha draws opaque whatever its fourth channel.
		s.opaque = !info.hasAlpha
		s.wideGamut = isWideGamutIcc(info.icc)
		applyColorSpace(s)

		await ensurePreview(s).catch(ignoreContextLoss)

		return { width: pixels.width, height: pixels.height }
	},

	render(id: number, recipe: ImageEditRecipe, options: { compare: boolean }): void {
		const s = current(id)

		s.latest = { recipe, compare: options.compare }
		queueFrame(s)
	},

	async filterThumbnails(id: number, recipe: ImageEditRecipe, size: number): Promise<ImageBitmap[]> {
		const s = current(id)

		await ensurePreview(s)

		const { renderer, source } = s

		if (renderer === null) {
			throw new ContextLostError()
		}

		if (source === null) {
			throw new Error("no image loaded")
		}

		const frames = [null, ...FILTER_PRESETS.map(preset => preset.id)].map(filter => frameOf({ ...recipe, filter }, source, false))
		const strip = renderer.thumbnails(frames, size, s.opaque)
		const image = new ImageData(new Uint8ClampedArray(strip.buffer), size * frames.length, size)
		const bitmaps = await Promise.all(frames.map((_, index) => createImageBitmap(image, index * size, 0, size, size)))

		return Comlink.transfer(bitmaps, bitmaps)
	},

	async export(
		id: number,
		recipe: ImageEditRecipe,
		target: { mime: "image/jpeg" | "image/png" | "image/webp"; quality: number },
		meta: ExportMeta
	): Promise<Blob> {
		await exportLock.acquire()

		try {
			const s = current(id)
			const { renderer, source } = s

			if (renderer === null) {
				throw new ContextLostError()
			}

			if (source === null) {
				throw new Error("no image loaded")
			}

			await loadMarkupFonts(recipe.markup)

			const frame = frameOf(recipe, source, false)
			const pixels = await renderer.exportPixels(frame, source, s.opaque, (rect, pad) => sourceRectForTile(recipe, source, rect, pad))

			return await encodeImage(pixels, frame.output.width, frame.output.height, target, meta)
		} finally {
			exportLock.release()
		}
	},

	// Frees the session's GPU objects, context and source. Idempotent; a stale id is ignored.
	close(id: number): void {
		const s = session

		if (s?.id !== id) {
			return
		}

		session = null
		s.latest = null
		releaseContext(s)
		releaseSource(s)
	}
}

export type RenderWorkerApi = typeof api

Comlink.expose(api)
