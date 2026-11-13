import { gradeUniforms, IDENTITY_GRADE, TRANSFER_BT709, type GradeUniforms } from "@/lib/gl/colorGrade"
import type { Matrix3, Size } from "@/features/preview/imageEdit/lib/recipe"
import type { HdrHandling, TextOverlay, TransferCharacteristic, VideoEditRecipe, VideoRotation } from "@/features/preview/videoEdit/types"
import { hasColourWork } from "@/features/preview/videoEdit/lib/plan"
import {
	minification,
	needsGpuPass,
	outputToTexture,
	overlayBox,
	overlayVisible,
	videoGrade,
	type PipelineNeedOptions
} from "@/features/preview/videoEdit/gl/pipeline.logic"
import { VIDEO_FRAGMENTS, VIDEO_VERTEX, type VideoProgramName } from "@/features/preview/videoEdit/gl/shaders"
import { rasterizeText } from "@/features/preview/videoEdit/gl/textRaster"
import { textRasterKey } from "@/features/preview/videoEdit/gl/textRaster.logic"

// The video editor's per-frame GPU pass, shared by the export worker and the preview worker so both draw the same
// frame: one WebGL 2 render pass on an OffscreenCanvas does crop, rotation, flip, resize, the colour grade (the image
// editor's, BT.709 transfer), an HDR → SDR tone map when asked, and the text boxes (each rasterised once to a texture,
// re-rasterised only when its content, look or the output size changes). The decoded VideoFrame goes in through
// texImage2D (the browser's own zero-copy import where it has one), the result comes out as a VideoFrame made from
// the canvas.
//
// Steady state allocates nothing of its own per frame: the uniforms, the texture-coordinate map and the grade are
// recomputed only when the recipe object or the sizes change, and the source texture and the plane staging buffer are
// reused. A lost context throws ContextLostError until the browser restores it; everything is then rebuilt.

export interface FramePipeline {
	// `frame` stays the caller's (never closed here). The result is `outWidth`×`outHeight`, timestamped at
	// `outputTimeSec` with the frame's duration divided by the speed.
	render(
		frame: VideoFrame,
		recipe: VideoEditRecipe,
		outWidth: number,
		outHeight: number,
		outputTimeSec: number,
		hdr: HdrHandling | null
	): VideoFrame
	// render(), but a 10-bit planar HDR frame is tone-mapped from its own code values (VideoFrame.copyTo) rather than
	// from what the browser's RGB upload makes of it. The frame must stay open until this settles.
	renderAsync(
		frame: VideoFrame,
		recipe: VideoEditRecipe,
		outWidth: number,
		outHeight: number,
		outputTimeSec: number,
		hdr: HdrHandling | null
	): Promise<VideoFrame>
	// The same pass for a preview: the canvas's pixels handed off as a bitmap the caller owns. An HDR frame is
	// tone-mapped from the browser's RGB upload (no plane copy per frame: a preview need not be exact to the code value).
	renderBitmap(
		frame: VideoFrame,
		recipe: VideoEditRecipe,
		outWidth: number,
		outHeight: number,
		outputTimeSec: number,
		hdr: HdrHandling | null
	): ImageBitmap
	// Deletes the text textures of overlays not in `overlays` (a preview's stage after an edit). Rendering never prunes
	// on its own, so a pass with another recipe in between (a filter thumbnail) costs the stage no re-rasterising.
	pruneText(overlays: readonly TextOverlay[]): void
	// Whether the recipe needs this pass at all (pipeline.logic needsGpuPass).
	needsGpu(recipe: VideoEditRecipe, options?: PipelineNeedOptions): boolean
	dispose(): void
}

export interface FramePipelineOptions {
	// The source's rotation metadata: the decoded picture is turned by it into the display space the crop is in.
	sourceRotation?: VideoRotation
	// For an HDR source whose frames do not say (VideoFrame.colorSpace.transfer), which curve the tone map undoes.
	sourceTransfer?: TransferCharacteristic
	// The decoded (unrotated) picture's size in square pixels, which the crop is measured in. A frame's own display
	// size is not trusted for it: WebKit reports an anamorphic frame's coded size there.
	naturalSize?: { width: number; height: number }
}

export class ContextLostError extends Error {
	public constructor() {
		super("WebGL context lost")
		this.name = "ContextLostError"
	}
}

// "keep" and "hevc10" carry the source's HDR signal into the encoder; an 8-bit canvas cannot, so such frames never
// come through this pass (the plan routes them around it).
export class HdrPassthroughError extends Error {
	public constructor(hdr: HdrHandling) {
		super(`the frame pass cannot carry HDR ("${hdr}"); only "toSdr" or SDR frames come through it`)
		this.name = "HdrPassthroughError"
	}
}

// Texture units: the frame, the three planes, then text.
const UNIT_SOURCE = 0
const UNIT_Y = 1
const UNIT_U = 2
const UNIT_V = 3
const UNIT_TEXT = 4

// Past this many texels per output pixel the source is sampled through a mipmap chain.
const MIPMAP_MINIFICATION = 2

// 10-bit planar layouts VideoFrame.copyTo gives, with their chroma subsampling.
const PLANAR_10: Readonly<Record<string, { x: number; y: number }>> = {
	I420P10: { x: 2, y: 2 },
	I422P10: { x: 2, y: 1 },
	I444P10: { x: 1, y: 1 }
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
	alpha: false,
	premultipliedAlpha: false,
	antialias: false,
	depth: false,
	stencil: false,
	preserveDrawingBuffer: false,
	powerPreference: "default"
}

type Uniforms = Record<string, WebGLUniformLocation | null>

interface Program {
	program: WebGLProgram
	uniforms: Uniforms
}

const PROGRAM_UNIFORMS: Record<VideoProgramName, readonly string[]> = {
	frame: [
		"u_rect",
		"u_source",
		"u_outToTexX",
		"u_outToTexY",
		"u_outSize",
		"u_input",
		"u_grade",
		"u_adjustA",
		"u_adjustB",
		"u_adjustC",
		"u_transfer"
	],
	planes: [
		"u_rect",
		"u_planeY",
		"u_planeU",
		"u_planeV",
		"u_lumaSize",
		"u_chromaSize",
		"u_outToTexX",
		"u_outToTexY",
		"u_outSize",
		"u_input",
		"u_fullRange",
		"u_grade",
		"u_adjustA",
		"u_adjustB",
		"u_adjustC",
		"u_transfer"
	],
	text: ["u_rect", "u_text", "u_box", "u_outSize"]
}

interface TextTexture {
	key: string
	texture: WebGLTexture
	width: number
	height: number
}

interface PlaneStaging {
	buffer: ArrayBuffer
	view: Uint16Array
	format: string
	layout: PlaneLayout[]
	lumaWidth: number
	lumaHeight: number
	chromaWidth: number
	chromaHeight: number
}

interface GlState {
	gl: WebGL2RenderingContext
	vao: WebGLVertexArrayObject
	source: WebGLTexture
	planes: [WebGLTexture, WebGLTexture, WebGLTexture]
	// The plane textures' allocated sizes (texStorage2D is immutable; a new size makes new textures).
	planeSizes: string
	programs: Partial<Record<VideoProgramName, Program>>
	text: Map<string, TextTexture>
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type)

	if (shader === null) {
		throw new ContextLostError()
	}

	gl.shaderSource(shader, source)
	gl.compileShader(shader)

	if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true && !gl.isContextLost()) {
		const info = gl.getShaderInfoLog(shader)

		gl.deleteShader(shader)

		throw new Error(`shader failed to compile: ${info ?? ""}`)
	}

	return shader
}

function link(gl: WebGL2RenderingContext, name: VideoProgramName): Program {
	const program = gl.createProgram()
	const vertex = compile(gl, gl.VERTEX_SHADER, VIDEO_VERTEX)
	const fragment = compile(gl, gl.FRAGMENT_SHADER, VIDEO_FRAGMENTS[name])

	gl.attachShader(program, vertex)
	gl.attachShader(program, fragment)
	gl.linkProgram(program)
	gl.deleteShader(vertex)
	gl.deleteShader(fragment)

	if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true && !gl.isContextLost()) {
		const info = gl.getProgramInfoLog(program)

		gl.deleteProgram(program)

		throw new Error(`program failed to link: ${info ?? ""}`)
	}

	const uniforms: Uniforms = {}

	for (const uniform of PROGRAM_UNIFORMS[name]) {
		uniforms[uniform] = gl.getUniformLocation(program, uniform)
	}

	return { program, uniforms }
}

function filteredTexture(gl: WebGL2RenderingContext): WebGLTexture {
	const texture = gl.createTexture()

	gl.bindTexture(gl.TEXTURE_2D, texture)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

	return texture
}

function integerTexture(gl: WebGL2RenderingContext): WebGLTexture {
	const texture = gl.createTexture()

	gl.bindTexture(gl.TEXTURE_2D, texture)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

	return texture
}

function createGlState(gl: WebGL2RenderingContext): GlState {
	gl.disable(gl.DEPTH_TEST)
	gl.disable(gl.DITHER)
	gl.disable(gl.BLEND)
	// Pixels go up as decoded: no flip, no premultiplication, no colour conversion (WebGL 1.0 §5.14.8), so the shader
	// sees the stream's own transfer and primaries.
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)

	const vao = gl.createVertexArray()

	return {
		gl,
		vao,
		source: filteredTexture(gl),
		planes: [integerTexture(gl), integerTexture(gl), integerTexture(gl)],
		planeSizes: "",
		programs: { frame: link(gl, "frame"), text: link(gl, "text") },
		text: new Map()
	}
}

function loc(p: Program, name: string): WebGLUniformLocation | null {
	return p.uniforms[name] ?? null
}

function program(state: GlState, name: VideoProgramName): Program {
	let built = state.programs[name]

	if (built === undefined) {
		built = link(state.gl, name)
		state.programs[name] = built
	}

	return built
}

function frameTransfer(frame: VideoFrame, fallback: TransferCharacteristic | undefined): 1 | 2 {
	// The DOM typings predate the HDR curves WebCodecs reports ("pq", "hlg").
	const transfer: string | null = frame.colorSpace.transfer

	if (transfer === "pq") {
		return 1
	}

	if (transfer === "hlg") {
		return 2
	}

	return fallback === "pq" ? 1 : 2
}

// What the uniforms derive from, recomputed only when one of these changes.
interface Derived {
	recipe: VideoEditRecipe | null
	outWidth: number
	outHeight: number
	naturalWidth: number
	naturalHeight: number
	matrix: Matrix3
	grade: GradeUniforms
	graded: boolean
	minification: number
}

export function createFramePipeline(canvas: OffscreenCanvas, options: FramePipelineOptions = {}): FramePipeline {
	const sourceRotation = options.sourceRotation ?? 0
	let state: GlState | null = null
	let lost = false
	let disposed = false
	let staging: PlaneStaging | null = null
	const derived: Derived = {
		recipe: null,
		outWidth: 0,
		outHeight: 0,
		naturalWidth: 0,
		naturalHeight: 0,
		matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
		grade: IDENTITY_GRADE,
		graded: false,
		minification: 1
	}

	const context = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES)

	if (context === null) {
		throw new Error("WebGL 2 unavailable")
	}

	const gl = context

	// Default handling of a lost context is to never restore it; preventing it asks for a restore (WebGL 1.0 §5.15.2).
	const onLost = (event: Event): void => {
		event.preventDefault()
		lost = true
		state = null
	}
	const onRestored = (): void => {
		lost = false
		derived.recipe = null
	}

	canvas.addEventListener("webglcontextlost", onLost)
	canvas.addEventListener("webglcontextrestored", onRestored)

	function ready(): GlState {
		if (disposed) {
			throw new Error("frame pipeline disposed")
		}

		if (lost || gl.isContextLost()) {
			throw new ContextLostError()
		}

		state ??= createGlState(gl)

		return state
	}

	function derive(frame: VideoFrame, recipe: VideoEditRecipe, outWidth: number, outHeight: number): void {
		const naturalWidth = options.naturalSize?.width ?? frame.displayWidth
		const naturalHeight = options.naturalSize?.height ?? frame.displayHeight

		if (
			derived.recipe === recipe &&
			derived.outWidth === outWidth &&
			derived.outHeight === outHeight &&
			derived.naturalWidth === naturalWidth &&
			derived.naturalHeight === naturalHeight
		) {
			return
		}

		const turned = sourceRotation % 180 !== 0
		const display: Size = turned ? { width: naturalHeight, height: naturalWidth } : { width: naturalWidth, height: naturalHeight }

		derived.matrix = outputToTexture(display, sourceRotation, recipe, { width: outWidth, height: outHeight })
		derived.graded = hasColourWork(recipe)
		derived.grade = gradeUniforms(videoGrade(recipe))
		derived.minification = minification({ width: naturalWidth, height: naturalHeight }, derived.matrix)
		derived.recipe = recipe
		derived.outWidth = outWidth
		derived.outHeight = outHeight
		derived.naturalWidth = naturalWidth
		derived.naturalHeight = naturalHeight
	}

	function setCommon(p: Program, outWidth: number, outHeight: number, input: number): void {
		const m = derived.matrix

		gl.uniform4f(loc(p, "u_rect"), -1, -1, 1, 1)
		gl.uniform3f(loc(p, "u_outToTexX"), m[0], m[3], m[6])
		gl.uniform3f(loc(p, "u_outToTexY"), m[1], m[4], m[7])
		gl.uniform2f(loc(p, "u_outSize"), outWidth, outHeight)
		gl.uniform1i(loc(p, "u_input"), input)
		gl.uniform1i(loc(p, "u_grade"), derived.graded ? 1 : 0)
		gl.uniform1i(loc(p, "u_transfer"), TRANSFER_BT709)

		const { adjustA, adjustB, adjustC } = derived.grade

		gl.uniform4f(loc(p, "u_adjustA"), adjustA[0], adjustA[1], adjustA[2], adjustA[3])
		gl.uniform4f(loc(p, "u_adjustB"), adjustB[0], adjustB[1], adjustB[2], adjustB[3])
		gl.uniform2f(loc(p, "u_adjustC"), adjustC[0], adjustC[1])
	}

	function sizeCanvas(outWidth: number, outHeight: number): void {
		if (canvas.width !== outWidth) {
			canvas.width = outWidth
		}

		if (canvas.height !== outHeight) {
			canvas.height = outHeight
		}

		gl.viewport(0, 0, outWidth, outHeight)
	}

	function drawRgb(s: GlState, frame: VideoFrame, input: number, outWidth: number, outHeight: number): void {
		const p = program(s, "frame")

		gl.activeTexture(gl.TEXTURE0 + UNIT_SOURCE)
		gl.bindTexture(gl.TEXTURE_2D, s.source)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

		const mipmapped = derived.minification > MIPMAP_MINIFICATION

		if (mipmapped) {
			gl.generateMipmap(gl.TEXTURE_2D)
		}

		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
		gl.useProgram(p.program)
		gl.uniform1i(loc(p, "u_source"), UNIT_SOURCE)
		setCommon(p, outWidth, outHeight, input)
		gl.bindVertexArray(s.vao)
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
	}

	function drawPlanes(s: GlState, planes: PlaneStaging, input: number, fullRange: boolean, outWidth: number, outHeight: number): void {
		const p = program(s, "planes")
		const sizes = `${String(planes.lumaWidth)}x${String(planes.lumaHeight)}:${String(planes.chromaWidth)}x${String(planes.chromaHeight)}`

		if (s.planeSizes !== sizes) {
			for (const texture of s.planes) {
				gl.deleteTexture(texture)
			}

			s.planes = [integerTexture(gl), integerTexture(gl), integerTexture(gl)]
			s.planeSizes = sizes

			for (const [index, texture] of s.planes.entries()) {
				gl.bindTexture(gl.TEXTURE_2D, texture)
				gl.texStorage2D(
					gl.TEXTURE_2D,
					1,
					gl.R16UI,
					index === 0 ? planes.lumaWidth : planes.chromaWidth,
					index === 0 ? planes.lumaHeight : planes.chromaHeight
				)
			}
		}

		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)

		for (const [index, texture] of s.planes.entries()) {
			const layout = planes.layout[index]

			if (layout === undefined) {
				continue
			}

			gl.activeTexture(gl.TEXTURE0 + UNIT_Y + index)
			gl.bindTexture(gl.TEXTURE_2D, texture)
			gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride / 2)
			gl.texSubImage2D(
				gl.TEXTURE_2D,
				0,
				0,
				0,
				index === 0 ? planes.lumaWidth : planes.chromaWidth,
				index === 0 ? planes.lumaHeight : planes.chromaHeight,
				gl.RED_INTEGER,
				gl.UNSIGNED_SHORT,
				planes.view,
				layout.offset / 2
			)
		}

		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
		gl.useProgram(p.program)
		gl.uniform1i(loc(p, "u_planeY"), UNIT_Y)
		gl.uniform1i(loc(p, "u_planeU"), UNIT_U)
		gl.uniform1i(loc(p, "u_planeV"), UNIT_V)
		gl.uniform2f(loc(p, "u_lumaSize"), planes.lumaWidth, planes.lumaHeight)
		gl.uniform2f(loc(p, "u_chromaSize"), planes.chromaWidth, planes.chromaHeight)
		gl.uniform1i(loc(p, "u_fullRange"), fullRange ? 1 : 0)
		setCommon(p, outWidth, outHeight, input)
		gl.bindVertexArray(s.vao)
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
	}

	function pruneText(s: GlState, overlays: readonly TextOverlay[]): void {
		for (const [id, entry] of s.text) {
			if (!overlays.some(overlay => overlay.id === id)) {
				gl.deleteTexture(entry.texture)
				s.text.delete(id)
			}
		}
	}

	// The overlay's texture for this output size, rasterised only when its key changed; null when it shows nothing.
	function textTexture(s: GlState, overlay: TextOverlay, outWidth: number, outHeight: number): TextTexture | null {
		const out = { width: outWidth, height: outHeight }
		const existing = s.text.get(overlay.id)

		if (existing?.key === textRasterKey(overlay, out)) {
			return existing
		}

		if (existing !== undefined) {
			gl.deleteTexture(existing.texture)
			s.text.delete(overlay.id)
		}

		const raster = rasterizeText(overlay, out)

		if (raster === null) {
			return null
		}

		const texture = filteredTexture(gl)

		try {
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster.bitmap)
		} finally {
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
			// The texture holds the pixels; the bitmap's copy goes.
			raster.bitmap.close()
		}

		const entry: TextTexture = { key: raster.key, texture, width: raster.width, height: raster.height }

		s.text.set(overlay.id, entry)

		return entry
	}

	function drawText(s: GlState, recipe: VideoEditRecipe, outputTimeSec: number, outWidth: number, outHeight: number): void {
		let started = false

		for (const overlay of recipe.text) {
			if (!overlayVisible(overlay, outputTimeSec)) {
				continue
			}

			const entry = textTexture(s, overlay, outWidth, outHeight)

			if (entry === null) {
				continue
			}

			const p = program(s, "text")

			if (!started) {
				started = true
				gl.useProgram(p.program)
				gl.enable(gl.BLEND)
				gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
				gl.uniform1i(loc(p, "u_text"), UNIT_TEXT)
				gl.uniform2f(loc(p, "u_outSize"), outWidth, outHeight)
				gl.activeTexture(gl.TEXTURE0 + UNIT_TEXT)
			}

			const box = overlayBox(overlay, entry, { width: outWidth, height: outHeight })

			gl.bindTexture(gl.TEXTURE_2D, entry.texture)
			gl.uniform4f(loc(p, "u_box"), box.left, box.top, box.right, box.bottom)
			gl.uniform4f(
				loc(p, "u_rect"),
				(box.left / outWidth) * 2 - 1,
				1 - (box.bottom / outHeight) * 2,
				(box.right / outWidth) * 2 - 1,
				1 - (box.top / outHeight) * 2
			)
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
		}

		if (started) {
			gl.disable(gl.BLEND)
		}
	}

	function inputFor(hdr: HdrHandling | null, frame: VideoFrame): number {
		if (hdr === "keep" || hdr === "hevc10") {
			throw new HdrPassthroughError(hdr)
		}

		return hdr === "toSdr" ? frameTransfer(frame, options.sourceTransfer) : 0
	}

	function check(outWidth: number, outHeight: number): void {
		if (!Number.isInteger(outWidth) || !Number.isInteger(outHeight) || outWidth < 1 || outHeight < 1) {
			throw new RangeError(`invalid output size ${String(outWidth)}×${String(outHeight)}`)
		}
	}

	// Draws the frame into the canvas (RGB upload, or the staged planes when given).
	function draw(
		frame: VideoFrame,
		recipe: VideoEditRecipe,
		outWidth: number,
		outHeight: number,
		outputTimeSec: number,
		hdr: HdrHandling | null,
		planes: PlaneStaging | null
	): void {
		check(outWidth, outHeight)

		const input = inputFor(hdr, frame)
		const s = ready()

		derive(frame, recipe, outWidth, outHeight)
		sizeCanvas(outWidth, outHeight)

		if (planes !== null && input !== 0) {
			drawPlanes(s, planes, input, frame.colorSpace.fullRange === true, outWidth, outHeight)
		} else {
			drawRgb(s, frame, input, outWidth, outHeight)
		}

		drawText(s, recipe, outputTimeSec, outWidth, outHeight)

		if (gl.isContextLost()) {
			throw new ContextLostError()
		}
	}

	function wrap(frame: VideoFrame, recipe: VideoEditRecipe, outputTimeSec: number): VideoFrame {
		const duration = frame.duration

		return new VideoFrame(canvas, {
			timestamp: Math.round(outputTimeSec * 1e6),
			...(duration === null ? {} : { duration: Math.max(1, Math.round(duration / recipe.speed)) }),
			alpha: "discard"
		})
	}

	// The frame's planes copied into the reused staging buffer; null when it is not 10-bit planar.
	async function stagePlanes(frame: VideoFrame): Promise<PlaneStaging | null> {
		const format = frame.format
		const subsampling = format === null ? undefined : PLANAR_10[format]

		if (format === null || subsampling === undefined) {
			return null
		}

		const size = frame.allocationSize()
		let target = staging

		if (target === null || target.buffer.byteLength < size) {
			const buffer = new ArrayBuffer(size)

			target = {
				buffer,
				view: new Uint16Array(buffer),
				format,
				layout: [],
				lumaWidth: 0,
				lumaHeight: 0,
				chromaWidth: 0,
				chromaHeight: 0
			}
			staging = target
		}

		const visible = frame.visibleRect
		const width = visible?.width ?? frame.codedWidth
		const height = visible?.height ?? frame.codedHeight

		target.layout = await frame.copyTo(target.buffer)
		target.format = format
		target.lumaWidth = width
		target.lumaHeight = height
		target.chromaWidth = Math.ceil(width / subsampling.x)
		target.chromaHeight = Math.ceil(height / subsampling.y)

		return target
	}

	return {
		render: (frame, recipe, outWidth, outHeight, outputTimeSec, hdr) => {
			draw(frame, recipe, outWidth, outHeight, outputTimeSec, hdr, null)

			return wrap(frame, recipe, outputTimeSec)
		},
		renderAsync: async (frame, recipe, outWidth, outHeight, outputTimeSec, hdr) => {
			const planes = hdr === "toSdr" ? await stagePlanes(frame) : null

			draw(frame, recipe, outWidth, outHeight, outputTimeSec, hdr, planes)

			return wrap(frame, recipe, outputTimeSec)
		},
		renderBitmap: (frame, recipe, outWidth, outHeight, outputTimeSec, hdr) => {
			draw(frame, recipe, outWidth, outHeight, outputTimeSec, hdr, null)

			return canvas.transferToImageBitmap()
		},
		pruneText: overlays => {
			if (state !== null && !disposed && !lost) {
				pruneText(state, overlays)
			}
		},
		needsGpu: (recipe, needOptions) => needsGpuPass(recipe, needOptions),
		dispose: () => {
			if (disposed) {
				return
			}

			disposed = true
			canvas.removeEventListener("webglcontextlost", onLost)
			canvas.removeEventListener("webglcontextrestored", onRestored)
			staging = null

			const s = state

			state = null

			if (gl.isContextLost()) {
				return
			}

			if (s !== null) {
				for (const entry of s.text.values()) {
					gl.deleteTexture(entry.texture)
				}

				gl.deleteTexture(s.source)

				for (const texture of s.planes) {
					gl.deleteTexture(texture)
				}

				for (const built of Object.values(s.programs)) {
					gl.deleteProgram(built.program)
				}

				gl.deleteVertexArray(s.vao)
			}

			// Frees the context and its drawing buffer now rather than at collection, whether or not anything was drawn.
			gl.getExtension("WEBGL_lose_context")?.loseContext()
		}
	}
}
