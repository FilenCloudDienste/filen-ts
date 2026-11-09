import type { MarkupItem } from "@/features/preview/imageEdit/types"
import { hasLayer, rasterizeMarkup } from "@/features/preview/imageEdit/worker/markup"
import {
	createPrograms,
	deletePrograms,
	UNIT_HIGHLIGHT,
	UNIT_INK,
	UNIT_MAIN,
	type Program,
	type ProgramName
} from "@/features/preview/imageEdit/worker/shaders"
import { invertMatrix3, type Matrix3, type Rect } from "@/features/preview/imageEdit/lib/recipe"
import {
	affine,
	composeMatrix3,
	matrixRows,
	matrixScale,
	containTransform,
	coverTransform,
	expandRect,
	exportTileEdge,
	planTiles,
	previewMargin,
	previewSize,
	previewUploadTiles,
	scaleTranslate,
	sharpenPad,
	sharpenRadius
} from "@/features/preview/imageEdit/worker/tiles"

// The WebGL 2 side of the render worker: the preview texture, the on-screen draw, the tiled full-resolution
// export and the filter thumbnails, all on the one context of the transferred canvas. Every pass binds the whole
// state it needs, so an export awaiting between tiles can interleave with preview frames.

export class ContextLostError extends Error {
	constructor() {
		super("WebGL context lost")
		this.name = "ContextLostError"
	}
}

// The full-resolution original the session keeps: a decoded bitmap (straight alpha, no colour conversion) or a
// decoder's RGBA.
export type SourcePixels =
	| { kind: "bitmap"; bitmap: ImageBitmap; width: number; height: number }
	| { kind: "rgba"; data: Uint8Array<ArrayBuffer>; width: number; height: number }

// What one frame draws, already resolved from the recipe.
export interface Frame {
	output: { width: number; height: number }
	// Output pixels → upright source pixels.
	outputToSource: Matrix3
	// exposure, brightness, contrast, highlights; shadows, warmth, tint, saturation; vibrance, vignette. −1..1 / 0..1.
	adjustA: readonly [number, number, number, number]
	adjustB: readonly [number, number, number, number]
	adjustC: readonly [number, number]
	// 0..1; 0 skips the sharpen pass.
	sharpness: number
	markup: readonly MarkupItem[]
}

// The scaled-down source the screen and the thumbnails sample; width/height are the SOURCE's.
export interface PreviewTexture {
	texture: WebGLTexture
	width: number
	height: number
}

interface Target {
	texture: WebGLTexture
	framebuffer: WebGLFramebuffer
	width: number
	height: number
}

interface MarkupLayers {
	ink: OffscreenCanvasRenderingContext2D
	highlight: OffscreenCanvasRenderingContext2D
	inkTexture: WebGLTexture
	highlightTexture: WebGLTexture
}

// The preview texture's long side: sharp on a large high-density screen, ~38 MB with its mip chain at 4:3.
const PREVIEW_EDGE = 3072
// Uploads and export tiles stay within this even where MAX_TEXTURE_SIZE allows more, bounding each texture to
// 64 MB.
const TILE_EDGE = 4096
// Source pixels around an export tile's inverse-mapped bounds for bilinear filtering.
const SOURCE_PAD = 2
// Unsharp-mask strength at sharpness 100.
const SHARPEN_MAX = 1.5

function ndcRect(rect: Rect, width: number, height: number): [number, number, number, number] {
	return [
		(rect.x / width) * 2 - 1,
		(rect.y / height) * 2 - 1,
		((rect.x + rect.width) / width) * 2 - 1,
		((rect.y + rect.height) / height) * 2 - 1
	]
}

const FULL_NDC: [number, number, number, number] = [-1, -1, 1, 1]

export class Renderer {
	readonly gl: WebGL2RenderingContext
	readonly maxTexture: number
	private readonly programs: Record<ProgramName, Program>
	private readonly vao: WebGLVertexArrayObject
	private preview: PreviewTexture | null = null
	// The preview's colour pass when sharpening, canvas-sized.
	private intermediate: Target | null = null
	private layers: MarkupLayers | null = null
	// What the layer textures hold for the preview, so an unchanged markup is not rasterised again.
	private previewMarkupKey: string | null = null

	constructor(gl: WebGL2RenderingContext) {
		this.gl = gl
		this.maxTexture = Math.min(
			gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
			gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
			...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)
		)
		this.programs = createPrograms(gl)
		this.vao = gl.createVertexArray()

		gl.disable(gl.BLEND)
		gl.disable(gl.DEPTH_TEST)
		gl.disable(gl.DITHER)
		// Pixels go up as stored: no flip, no premultiplication, no colour conversion (WebGL 1.0 §5.14.8).
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
	}

	private lostCheck(): void {
		if (this.gl.isContextLost()) {
			throw new ContextLostError()
		}
	}

	private texture(width: number, height: number, mipmapped: boolean): WebGLTexture {
		const gl = this.gl
		const texture = gl.createTexture()
		const levels = mipmapped ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1

		// Unit 0 only: every pass rebinds it, whereas a target left bound on a markup unit would be sampled while
		// drawn into (a feedback loop, WebGL 2.0 §5.21).
		gl.activeTexture(gl.TEXTURE0 + UNIT_MAIN)
		gl.bindTexture(gl.TEXTURE_2D, texture)
		gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height)
		this.sampling(mipmapped)

		return texture
	}

	private sampling(mipmapped: boolean): void {
		const gl = this.gl

		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
	}

	private target(width: number, height: number): Target {
		const gl = this.gl
		const texture = this.texture(width, height, false)
		const framebuffer = gl.createFramebuffer()

		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

		return { texture, framebuffer, width, height }
	}

	private deleteTarget(target: Target | null): void {
		if (target !== null) {
			this.gl.deleteFramebuffer(target.framebuffer)
			this.gl.deleteTexture(target.texture)
		}
	}

	// One source rectangle, ready to upload: the session's bitmap itself when it is the whole of it, else a cropped
	// copy the caller closes (createImageBitmap keeps the straight alpha and the stored colour values).
	private async sourcePart(source: SourcePixels, rect: Rect): Promise<ImageBitmap | null> {
		if (source.kind === "rgba") {
			return null
		}

		if (rect.x === 0 && rect.y === 0 && rect.width === source.width && rect.height === source.height) {
			return source.bitmap
		}

		return await createImageBitmap(source.bitmap, rect.x, rect.y, rect.width, rect.height, {
			premultiplyAlpha: "none",
			colorSpaceConversion: "none"
		})
	}

	// Uploads `rect` of the source into `texture` (re-specified at the rectangle's size), from `part` or, for
	// RGBA, straight out of the source buffer through the unpack row length and skips (WebGL 2.0 §3.7.6).
	private upload(texture: WebGLTexture, source: SourcePixels, rect: Rect, part: ImageBitmap | null): void {
		const gl = this.gl

		gl.activeTexture(gl.TEXTURE0 + UNIT_MAIN)
		gl.bindTexture(gl.TEXTURE_2D, texture)

		if (part !== null) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, part)

			return
		}

		if (source.kind !== "rgba") {
			throw new Error("bitmap source uploaded without its part")
		}

		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, source.width)
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, rect.x)
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, rect.y)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rect.width, rect.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data)
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
	}

	private use(name: ProgramName): Program {
		const program = this.programs[name]

		this.gl.useProgram(program.program)
		this.gl.bindVertexArray(this.vao)

		return program
	}

	private uniform(program: Program, name: string, ...values: number[]): void {
		const location = program.uniforms.get(name)

		if (location === undefined) {
			return
		}

		const gl = this.gl

		switch (values.length) {
			case 1:
				gl.uniform1f(location, values[0] ?? 0)
				break
			case 2:
				gl.uniform2f(location, values[0] ?? 0, values[1] ?? 0)
				break
			case 3:
				gl.uniform3f(location, values[0] ?? 0, values[1] ?? 0, values[2] ?? 0)
				break
			default:
				gl.uniform4f(location, values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0)
		}
	}

	private flag(program: Program, name: string, value: boolean): void {
		const location = program.uniforms.get(name)

		if (location !== undefined) {
			this.gl.uniform1i(location, value ? 1 : 0)
		}
	}

	private rows(program: Program, name: string, m: Matrix3): void {
		const rows = matrixRows(m)

		this.uniform(program, `${name}X`, ...rows.x)
		this.uniform(program, `${name}Y`, ...rows.y)
	}

	private draw(program: Program, rect: readonly [number, number, number, number]): void {
		this.uniform(program, "u_rect", ...rect)
		this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4)
	}

	// Draws the colour pass of `frame` into the bound framebuffer. `fragToOutput` maps that framebuffer's fragment
	// coordinates to output pixels; the source texture holds `texRect` of the upright source.
	private colorPass(
		frame: Frame,
		fragToOutput: Matrix3,
		texture: WebGLTexture,
		texRect: Rect,
		source: { width: number; height: number },
		opaque: boolean,
		markup: Matrix3 | null,
		premultiply: boolean
	): void {
		const gl = this.gl
		const program = this.use("color")

		gl.activeTexture(gl.TEXTURE0 + UNIT_MAIN)
		gl.bindTexture(gl.TEXTURE_2D, texture)
		this.rows(program, "u_fragToOut", fragToOutput)
		this.rows(program, "u_outToSrc", frame.outputToSource)
		this.uniform(program, "u_outSize", frame.output.width, frame.output.height)
		this.uniform(program, "u_srcSize", source.width, source.height)
		this.uniform(program, "u_texOrigin", texRect.x, texRect.y)
		this.uniform(program, "u_texSize", texRect.width, texRect.height)
		this.uniform(program, "u_adjustA", ...frame.adjustA)
		this.uniform(program, "u_adjustB", ...frame.adjustB)
		this.uniform(program, "u_adjustC", ...frame.adjustC)
		this.flag(program, "u_opaque", opaque)
		this.flag(program, "u_premultiply", premultiply)
		this.flag(program, "u_markup", markup !== null)
		this.markupUniforms(program, frame.markup, markup)
		this.draw(program, FULL_NDC)
	}

	private sharpenPass(
		frame: Frame,
		fragToOutput: Matrix3,
		inter: Target,
		outputToInter: Matrix3,
		radius: number,
		markup: Matrix3 | null,
		premultiply: boolean
	): void {
		const gl = this.gl
		const program = this.use("sharpen")

		gl.activeTexture(gl.TEXTURE0 + UNIT_MAIN)
		gl.bindTexture(gl.TEXTURE_2D, inter.texture)
		this.rows(program, "u_fragToOut", fragToOutput)
		this.rows(program, "u_outToInter", composeMatrix3(scaleTranslate(1 / inter.width, 1 / inter.height, 0, 0), outputToInter))
		this.uniform(program, "u_outSize", frame.output.width, frame.output.height)
		this.uniform(program, "u_amount", frame.sharpness * SHARPEN_MAX)
		this.uniform(program, "u_radius", radius)
		this.flag(program, "u_premultiply", premultiply)
		this.markupUniforms(program, frame.markup, markup)
		this.draw(program, FULL_NDC)
	}

	// `outputToCanvas`: output pixels → the layer canvases' pixels, or null for no markup in this pass.
	private markupUniforms(program: Program, items: readonly MarkupItem[], outputToCanvas: Matrix3 | null): void {
		const gl = this.gl
		const layers = outputToCanvas === null ? null : this.layers
		const ink = layers !== null && hasLayer(items, "ink")
		const highlight = layers !== null && hasLayer(items, "highlight")

		this.flag(program, "u_hasInk", ink)
		this.flag(program, "u_hasHighlight", highlight)

		if (layers === null || outputToCanvas === null) {
			return
		}

		const canvas = layers.ink.canvas

		this.rows(program, "u_outToMarkup", composeMatrix3(scaleTranslate(1 / canvas.width, 1 / canvas.height, 0, 0), outputToCanvas))
		gl.activeTexture(gl.TEXTURE0 + UNIT_INK)
		gl.bindTexture(gl.TEXTURE_2D, layers.inkTexture)
		gl.activeTexture(gl.TEXTURE0 + UNIT_HIGHLIGHT)
		gl.bindTexture(gl.TEXTURE_2D, layers.highlightTexture)
	}

	private markupLayers(width: number, height: number): MarkupLayers {
		if (this.layers === null) {
			const gl = this.gl
			const context = (): OffscreenCanvasRenderingContext2D => {
				const ctx = new OffscreenCanvas(width, height).getContext("2d")

				if (ctx === null) {
					throw new Error("2D canvas unavailable")
				}

				return ctx
			}
			const layerTexture = (): WebGLTexture => {
				const texture = gl.createTexture()

				gl.activeTexture(gl.TEXTURE0 + UNIT_MAIN)
				gl.bindTexture(gl.TEXTURE_2D, texture)
				this.sampling(false)

				return texture
			}

			this.layers = { ink: context(), highlight: context(), inkTexture: layerTexture(), highlightTexture: layerTexture() }
		}

		const layers = this.layers

		for (const ctx of [layers.ink, layers.highlight]) {
			if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
				ctx.canvas.width = width
				ctx.canvas.height = height
			}
		}

		return layers
	}

	// Rasterises `items` onto canvases of width × height and uploads them, premultiplied for the compositing math.
	private rasterize(items: readonly MarkupItem[], sourceToOutput: Matrix3, outputToCanvas: Matrix3, width: number, height: number): void {
		const gl = this.gl
		const layers = this.markupLayers(width, height)

		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)

		for (const [layer, ctx, texture] of [
			["ink", layers.ink, layers.inkTexture],
			["highlight", layers.highlight, layers.highlightTexture]
		] as const) {
			if (!hasLayer(items, layer)) {
				continue
			}

			rasterizeMarkup(ctx, items, layer, sourceToOutput, outputToCanvas)
			gl.activeTexture(gl.TEXTURE0 + (layer === "ink" ? UNIT_INK : UNIT_HIGHLIGHT))
			gl.bindTexture(gl.TEXTURE_2D, texture)
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas)
		}

		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
	}

	// Frees the markup canvases' backing stores and textures (an export's tile-sized ones, typically).
	private dropLayers(): void {
		if (this.layers === null) {
			return
		}

		this.gl.deleteTexture(this.layers.inkTexture)
		this.gl.deleteTexture(this.layers.highlightTexture)
		this.layers.ink.canvas.width = 0
		this.layers.highlight.canvas.width = 0
		this.layers = null
		this.previewMarkupKey = null
	}

	// The preview texture, not yet installed (see setPreview): the source scaled to at most PREVIEW_EDGE by
	// trilinear sampling of each uploaded tile's mip chain on the GPU, then mipmapped itself for any zoom out.
	async buildPreview(source: SourcePixels): Promise<PreviewTexture> {
		const gl = this.gl
		const size = previewSize(source.width, source.height, Math.min(PREVIEW_EDGE, this.maxTexture))
		const edge = Math.min(this.maxTexture, TILE_EDGE)
		const shrinking = size.scale < 1
		// Per axis: the rounded size stretches each axis by its own hair, and every texel row must be drawn.
		const sx = size.width / source.width
		const sy = size.height / source.height
		const tiles = previewUploadTiles(source.width, source.height, edge, shrinking ? previewMargin(size.scale) : 1)
		const texture = this.texture(size.width, size.height, true)
		const target = gl.createFramebuffer()
		const staging = gl.createTexture()

		gl.bindFramebuffer(gl.FRAMEBUFFER, target)
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

		const release = (): void => {
			gl.deleteTexture(staging)
			gl.deleteFramebuffer(target)
		}

		try {
			for (const { upload, inner } of tiles) {
				const part = await this.sourcePart(source, upload)

				try {
					this.lostCheck()
					this.upload(staging, source, upload, part)

					if (shrinking) {
						gl.generateMipmap(gl.TEXTURE_2D)
					}

					this.sampling(shrinking)

					const program = this.use("copy")
					// Preview fragment → source pixel → this upload's uv.
					const fragToUv = scaleTranslate(
						1 / (sx * upload.width),
						1 / (sy * upload.height),
						-upload.x / upload.width,
						-upload.y / upload.height
					)
					const dest = { x: inner.x * sx, y: inner.y * sy, width: inner.width * sx, height: inner.height * sy }

					gl.bindFramebuffer(gl.FRAMEBUFFER, target)
					gl.viewport(0, 0, size.width, size.height)
					this.rows(program, "u_fragToUv", fragToUv)
					this.draw(program, ndcRect(dest, size.width, size.height))
				} finally {
					if (part !== null && part !== (source.kind === "bitmap" ? source.bitmap : null)) {
						part.close()
					}
				}
			}

			this.lostCheck()
			gl.bindTexture(gl.TEXTURE_2D, texture)
			gl.generateMipmap(gl.TEXTURE_2D)
		} catch (error) {
			gl.deleteTexture(texture)

			throw error
		} finally {
			release()
		}

		return { texture, width: source.width, height: source.height }
	}

	// Installs a built preview in place of the current one.
	setPreview(preview: PreviewTexture): void {
		this.dropPreview()
		this.preview = preview
	}

	// A build that finished after its source was replaced.
	discardPreview(preview: PreviewTexture): void {
		this.gl.deleteTexture(preview.texture)
	}

	private dropPreview(): void {
		if (this.preview !== null) {
			this.gl.deleteTexture(this.preview.texture)
			this.preview = null
		}
	}

	// The output drawn whole and centred on the canvas (the editor's fitBox), transparent around it.
	drawPreview(frame: Frame, opaque: boolean): void {
		const gl = this.gl
		const preview = this.preview

		if (preview === null || gl.isContextLost()) {
			return
		}

		const width = gl.drawingBufferWidth
		const height = gl.drawingBufferHeight
		const fit = containTransform(frame.output, { width, height })
		// The canvas's fragment rows count from the bottom.
		const fragToOutput = composeMatrix3(invertMatrix3(fit), affine(1, 0, 0, -1, 0, height))
		const whole = { x: 0, y: 0, width: preview.width, height: preview.height }
		let markup: Matrix3 | null = null

		if (frame.markup.length > 0) {
			const key = JSON.stringify([frame.markup, frame.outputToSource, width, height])

			if (key !== this.previewMarkupKey) {
				this.rasterize(frame.markup, invertMatrix3(frame.outputToSource), fit, width, height)
				this.previewMarkupKey = key
			}

			markup = fit
		}

		if (frame.sharpness <= 0) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			gl.viewport(0, 0, width, height)
			this.colorPass(frame, fragToOutput, preview.texture, whole, preview, opaque, markup, true)

			return
		}

		if (this.intermediate?.width !== width || this.intermediate.height !== height) {
			this.deleteTarget(this.intermediate)
			this.intermediate = this.target(width, height)
		}

		const inter = this.intermediate

		gl.bindFramebuffer(gl.FRAMEBUFFER, inter.framebuffer)
		gl.viewport(0, 0, width, height)
		this.colorPass(frame, fragToOutput, preview.texture, whole, preview, opaque, null, false)

		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.viewport(0, 0, width, height)
		// At least one screen pixel, or a downscaled preview would show no sharpening at all.
		const radius = Math.max(sharpenRadius(frame.output.width, frame.output.height), 1 / matrixScale(fit))

		this.sharpenPass(frame, fragToOutput, inter, invertMatrix3(fragToOutput), radius, markup, true)
	}

	// Drops what only the preview's sharpen pass needs (on resize the next draw re-makes it at the new size).
	releaseIntermediate(): void {
		this.deleteTarget(this.intermediate)
		this.intermediate = null
	}

	// One size × size thumbnail per frame, side by side in one RGBA strip (row 0 on top), from the preview texture.
	thumbnails(frames: readonly Frame[], size: number, opaque: boolean): Uint8Array<ArrayBuffer> {
		const gl = this.gl
		const preview = this.preview

		this.lostCheck()

		if (preview === null) {
			throw new Error("no image loaded")
		}

		const strip = this.target(size * frames.length, size)
		const whole = { x: 0, y: 0, width: preview.width, height: preview.height }
		const pixels = new Uint8Array(strip.width * strip.height * 4)

		try {
			gl.bindFramebuffer(gl.FRAMEBUFFER, strip.framebuffer)

			frames.forEach((frame, index) => {
				gl.viewport(index * size, 0, size, size)
				// Strip fragment → thumbnail pixel (top-down, as read back) → output pixel.
				const fragToOutput = composeMatrix3(
					invertMatrix3(coverTransform(frame.output, size)),
					scaleTranslate(1, 1, -index * size, 0)
				)

				this.colorPass({ ...frame, markup: [] }, fragToOutput, preview.texture, whole, preview, opaque, null, false)
			})

			gl.readPixels(0, 0, strip.width, strip.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
			this.lostCheck()
		} finally {
			this.deleteTarget(strip)
		}

		return pixels
	}

	// The whole output at full resolution as straight-alpha RGBA, rendered tile by tile from source sub-rectangles
	// and read back straight into place in ONE buffer (PACK_ROW_LENGTH strides each tile's rows across it).
	// `sourceRectFor` gives the whole-pixel upright-source rectangle, clamped to the source, that an output
	// rectangle's pixels sample (grown by `pad` for the filter's reach).
	async exportPixels(
		frame: Frame,
		source: SourcePixels,
		opaque: boolean,
		sourceRectFor: (outputRect: Rect, pad: number) => Rect
	): Promise<Uint8Array<ArrayBuffer>> {
		const gl = this.gl
		const { width, height } = frame.output
		const limit = Math.min(this.maxTexture, TILE_EDGE)
		const radius = sharpenRadius(width, height)
		const pad = frame.sharpness > 0 ? sharpenPad(radius) : 0
		const edge = exportTileEdge(limit, pad, SOURCE_PAD, frame.outputToSource)
		const tiles = planTiles(width, height, edge)
		const tileWidth = Math.min(edge, width)
		const tileHeight = Math.min(edge, height)
		const sourceToOutput = invertMatrix3(frame.outputToSource)
		const out = new Uint8Array(width * height * 4)
		const staging = gl.createTexture()
		const final = this.target(tileWidth, tileHeight)
		const padded = pad > 0 ? this.target(tileWidth + 2 * pad, tileHeight + 2 * pad) : null
		const hasMarkup = frame.markup.length > 0

		try {
			for (const tile of tiles) {
				const outer = expandRect(tile, pad)
				const rect = sourceRectFor(outer, SOURCE_PAD)

				if (rect.width === 0 || rect.height === 0) {
					// Nothing of the source reaches this tile (the buffer is already transparent black).
					continue
				}

				const part = await this.sourcePart(source, rect)

				try {
					this.lostCheck()
					this.upload(staging, source, rect, part)
					this.sampling(false)

					const toCanvas = scaleTranslate(1, 1, -tile.x, -tile.y)

					if (hasMarkup) {
						this.rasterize(frame.markup, sourceToOutput, toCanvas, tileWidth, tileHeight)
						// A preview frame between tiles re-rasterises its own markup over these.
						this.previewMarkupKey = null
					}

					const markup = hasMarkup ? toCanvas : null

					if (padded === null) {
						gl.bindFramebuffer(gl.FRAMEBUFFER, final.framebuffer)
						gl.viewport(0, 0, tile.width, tile.height)
						this.colorPass(frame, scaleTranslate(1, 1, tile.x, tile.y), staging, rect, source, opaque, markup, false)
					} else {
						gl.bindFramebuffer(gl.FRAMEBUFFER, padded.framebuffer)
						gl.viewport(0, 0, outer.width, outer.height)
						this.colorPass(frame, scaleTranslate(1, 1, outer.x, outer.y), staging, rect, source, opaque, null, false)
						gl.bindFramebuffer(gl.FRAMEBUFFER, final.framebuffer)
						gl.viewport(0, 0, tile.width, tile.height)
						this.sharpenPass(
							frame,
							scaleTranslate(1, 1, tile.x, tile.y),
							padded,
							scaleTranslate(1, 1, -outer.x, -outer.y),
							radius,
							markup,
							false
						)
					}

					gl.bindFramebuffer(gl.FRAMEBUFFER, final.framebuffer)
					gl.pixelStorei(gl.PACK_ROW_LENGTH, width)
					gl.readPixels(0, 0, tile.width, tile.height, gl.RGBA, gl.UNSIGNED_BYTE, out, (tile.y * width + tile.x) * 4)
					gl.pixelStorei(gl.PACK_ROW_LENGTH, 0)
					this.lostCheck()
				} finally {
					if (part !== null && part !== (source.kind === "bitmap" ? source.bitmap : null)) {
						part.close()
					}
				}
			}
		} finally {
			if (!gl.isContextLost()) {
				gl.pixelStorei(gl.PACK_ROW_LENGTH, 0)
			}

			gl.deleteTexture(staging)
			this.deleteTarget(final)
			this.deleteTarget(padded)

			if (hasMarkup) {
				this.dropLayers()
			}
		}

		return out
	}

	// Frees every GPU object; the context itself is released by the caller.
	dispose(): void {
		const gl = this.gl

		this.dropPreview()
		this.releaseIntermediate()
		this.dropLayers()
		deletePrograms(gl, this.programs)
		gl.deleteVertexArray(this.vao)
	}
}
