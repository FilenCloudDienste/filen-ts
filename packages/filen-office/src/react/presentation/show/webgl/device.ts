import {
	COMPOSE_FRAGMENT,
	MORPH_FRAGMENT,
	MORPH_VERTEX,
	QUAD_VERTEX,
	SCREEN_VERTEX,
	screenFragment,
	TILES_FRAGMENT,
	TILES_VERTEX,
	type ScreenEffect
} from "./shaders"

// One WebGL2 context per document for the show's transitions: a canvas the runs place over the stage, the programs
// compiled once, and the bytes it holds counted (textures, and the drawing buffer at twice its size: the canvas
// is double-buffered). Held while something references it, and for LINGER_MS after the last release (the next
// slide's transition reuses its compiled programs: compiling them again takes a frame or more in some engines); then
// it loses the context on purpose, so its GPU memory goes at once rather than when the canvas is collected. Between
// runs it holds a 1 by 1 drawing buffer and no texture. A context the browser loses is never used again.

export type ProgramName = "compose" | "morph" | "tiles" | `screen:${ScreenEffect}`

function sources(name: ProgramName): readonly [string, string] {
	switch (name) {
		case "compose":
			return [QUAD_VERTEX, COMPOSE_FRAGMENT]
		case "morph":
			return [MORPH_VERTEX, MORPH_FRAGMENT]
		case "tiles":
			return [TILES_VERTEX, TILES_FRAGMENT]
		default:
			return [SCREEN_VERTEX, screenFragment(name.slice("screen:".length) as ScreenEffect)]
	}
}

// KHR_parallel_shader_compile's COMPLETION_STATUS_KHR.
const COMPLETION_STATUS = 0x91b1
// How often a program compiling in parallel is polled, and for how long at most.
const POLL_MS = 4
const POLL_LIMIT_MS = 10_000

export interface GlProgram {
	readonly program: WebGLProgram
	uniform(name: string): WebGLUniformLocation | null
}

export interface GlTexture {
	readonly texture: WebGLTexture
	readonly width: number
	readonly height: number
}

// The corner attribute's location in every program.
const CORNER = 0
const LINGER_MS = 60_000

export class GlDevice {
	readonly canvas: HTMLCanvasElement
	readonly gl: WebGL2RenderingContext
	readonly quad: WebGLVertexArrayObject
	// Bytes of the textures alive.
	textureBytes = 0
	private refs = 0
	private dead = false
	private linger: ReturnType<typeof setTimeout> | undefined
	private readonly programs = new Map<ProgramName, GlProgram | null>()
	private readonly owner: Document
	private readonly onLost: (event: Event) => void

	private constructor(owner: Document, canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, quad: WebGLVertexArrayObject) {
		this.owner = owner
		this.canvas = canvas
		this.gl = gl
		this.quad = quad
		this.onLost = (event: Event) => {
			event.preventDefault()
			this.dead = true

			if (DEVICES.get(this.owner) === this) DEVICES.delete(this.owner)
		}
		canvas.addEventListener("webglcontextlost", this.onLost)
	}

	// The document's device, made when it has none (undefined without WebGL2).
	static acquire(owner: Document): GlDevice | undefined {
		let device = DEVICES.get(owner)

		if (device === undefined || device.lost) {
			device = GlDevice.create(owner)

			if (device === undefined) return undefined

			DEVICES.set(owner, device)
		}

		device.refs++

		if (device.linger !== undefined) clearTimeout(device.linger)

		device.linger = undefined

		return device
	}

	private static create(owner: Document): GlDevice | undefined {
		const canvas = owner.createElement("canvas")

		canvas.width = 1
		canvas.height = 1
		canvas.className = "fo-show-gl"
		canvas.setAttribute("aria-hidden", "true")

		let gl: WebGL2RenderingContext | null = null

		try {
			gl = canvas.getContext("webgl2", {
				alpha: false,
				antialias: false,
				depth: false,
				stencil: false,
				premultipliedAlpha: true,
				preserveDrawingBuffer: false,
				powerPreference: "low-power",
				failIfMajorPerformanceCaveat: false
			})
		} catch {
			gl = null
		}

		if (gl === null || gl.isContextLost()) return undefined

		const vao = gl.createVertexArray()
		const buffer = gl.createBuffer()

		gl.bindVertexArray(vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
		gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1), gl.STATIC_DRAW)
		gl.enableVertexAttribArray(CORNER)
		gl.vertexAttribPointer(CORNER, 2, gl.FLOAT, false, 0, 0)
		gl.bindVertexArray(null)

		return new GlDevice(owner, canvas, gl, vao)
	}

	get lost(): boolean {
		return this.dead || this.gl.isContextLost()
	}

	// Bytes of the drawing buffer (front and back).
	get bufferBytes(): number {
		return this.canvas.width * this.canvas.height * 4 * 2
	}

	get bytes(): number {
		return this.textureBytes + this.bufferBytes
	}

	get maxSide(): number {
		const value: unknown = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)

		return typeof value === "number" && value > 0 ? value : 4096
	}

	// A program, compiled now when it is not yet (start() of a run that was not prepared).
	program(name: ProgramName): GlProgram | undefined {
		if (this.lost) return undefined

		const held = this.programs.get(name)

		if (held !== undefined) return held ?? undefined

		const pending = this.link(name)
		const made = pending === undefined ? undefined : this.finish(pending)

		this.programs.set(name, made ?? null)

		return made
	}

	// A program compiled without blocking where the driver compiles in parallel (KHR_parallel_shader_compile: the
	// status is polled across tasks instead of waited for); elsewhere as program().
	async prepareProgram(name: ProgramName): Promise<GlProgram | undefined> {
		if (this.lost) return undefined

		const held = this.programs.get(name)

		if (held !== undefined) return held ?? undefined

		const parallel = this.gl.getExtension("KHR_parallel_shader_compile") !== null
		const pending = this.link(name)

		if (pending !== undefined && parallel) {
			const begun = Date.now()

			while (
				!this.lost &&
				this.gl.getProgramParameter(pending.program, COMPLETION_STATUS) !== true &&
				Date.now() - begun < POLL_LIMIT_MS
			)
				await new Promise<void>(resolve => setTimeout(resolve, POLL_MS))
		}

		// Another caller finished it meanwhile.
		const again = this.programs.get(name)

		if (again !== undefined) {
			if (pending !== undefined) this.gl.deleteProgram(pending.program)

			return again ?? undefined
		}

		const made = pending === undefined || this.lost ? undefined : this.finish(pending)

		if (!this.lost) this.programs.set(name, made ?? null)

		return made
	}

	// Compiles and links, without asking how it went (asking waits for the driver).
	private link(name: ProgramName): { readonly program: WebGLProgram; readonly shaders: readonly WebGLShader[] } | undefined {
		const gl = this.gl
		const [vertex, fragment] = sources(name)
		const program = gl.createProgram()
		const shaders: WebGLShader[] = []

		for (const [type, source] of [
			[gl.VERTEX_SHADER, vertex],
			[gl.FRAGMENT_SHADER, fragment]
		] as const) {
			const shader = gl.createShader(type)

			if (shader === null) {
				for (const made of shaders) gl.deleteShader(made)

				gl.deleteProgram(program)

				return undefined
			}

			gl.shaderSource(shader, source)
			gl.compileShader(shader)
			gl.attachShader(program, shader)
			shaders.push(shader)
		}

		gl.bindAttribLocation(program, CORNER, "aCorner")
		gl.linkProgram(program)

		return { program, shaders }
	}

	private finish(pending: { readonly program: WebGLProgram; readonly shaders: readonly WebGLShader[] }): GlProgram | undefined {
		const gl = this.gl
		const program = pending.program

		for (const shader of pending.shaders) gl.deleteShader(shader)

		if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
			gl.deleteProgram(program)

			return undefined
		}

		return this.wrap(program)
	}

	private wrap(program: WebGLProgram): GlProgram {
		const gl = this.gl
		const locations = new Map<string, WebGLUniformLocation | null>()

		return {
			program,
			uniform(name) {
				let location = locations.get(name)

				if (location === undefined) {
					location = gl.getUniformLocation(program, name)
					locations.set(name, location)
				}

				return location
			}
		}
	}

	// An empty texture of the given size (a render target).
	target(width: number, height: number): GlTexture | undefined {
		const gl = this.gl
		const texture = gl.createTexture()

		gl.bindTexture(gl.TEXTURE_2D, texture)
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
		this.parameters()

		if (gl.getError() !== gl.NO_ERROR) {
			gl.deleteTexture(texture)

			return undefined
		}

		this.textureBytes += width * height * 4

		return { texture, width, height }
	}

	// A canvas (or other source) as a texture, premultiplied, row 0 its top row.
	upload(source: TexImageSource, width: number, height: number, into?: GlTexture): GlTexture | undefined {
		const gl = this.gl
		const texture = into?.texture ?? gl.createTexture()

		gl.bindTexture(gl.TEXTURE_2D, texture)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
		this.parameters()

		if (gl.getError() !== gl.NO_ERROR) {
			if (into === undefined) gl.deleteTexture(texture)

			return undefined
		}

		this.textureBytes += width * height * 4 - (into === undefined ? 0 : into.width * into.height * 4)

		return { texture, width, height }
	}

	// A source written into the top left of a texture made with target() (no storage is allocated, so nothing can run
	// out: no error check, which would wait for the GPU); false when it does not fit.
	uploadInto(texture: GlTexture, source: TexImageSource, width: number, height: number): boolean {
		if (width > texture.width || height > texture.height) return false

		const gl = this.gl

		gl.bindTexture(gl.TEXTURE_2D, texture.texture)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)

		return true
	}

	private parameters(): void {
		const gl = this.gl

		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
	}

	free(texture: GlTexture | undefined): void {
		if (texture === undefined) return

		this.gl.deleteTexture(texture.texture)
		this.textureBytes = Math.max(0, this.textureBytes - texture.width * texture.height * 4)
	}

	// The drawing buffer's size (1 by 1 between runs).
	resize(width: number, height: number): void {
		if (this.canvas.width !== width) this.canvas.width = width
		if (this.canvas.height !== height) this.canvas.height = height
	}

	release(): void {
		this.refs = Math.max(0, this.refs - 1)

		if (this.refs > 0) return

		this.resize(1, 1)
		this.canvas.remove()

		if (this.dead) {
			this.destroy()

			return
		}

		if (this.linger !== undefined) clearTimeout(this.linger)

		this.linger = setTimeout(() => {
			this.linger = undefined

			if (this.refs === 0) this.destroy()
		}, LINGER_MS)
	}

	// Loses the context now (also what a page leaving the show may call).
	destroy(): void {
		if (this.linger !== undefined) clearTimeout(this.linger)

		this.linger = undefined

		if (DEVICES.get(this.owner) === this) DEVICES.delete(this.owner)

		this.canvas.removeEventListener("webglcontextlost", this.onLost)
		this.canvas.remove()
		this.dead = true

		if (!this.gl.isContextLost()) this.gl.getExtension("WEBGL_lose_context")?.loseContext()

		this.canvas.width = 1
		this.canvas.height = 1
		this.textureBytes = 0
	}
}

const DEVICES = new WeakMap<Document, GlDevice>()

// Whether this realm has WebGL2 at all (a context may still fail to be made).
export function hasWebgl2(): boolean {
	return typeof Reflect.get(globalThis, "WebGL2RenderingContext") === "function"
}

// A 2D affine [a b c d e f] as a column-major mat3.
export function mat3(m: readonly number[]): Float32Array {
	return Float32Array.of(m[0] ?? 1, m[1] ?? 0, 0, m[2] ?? 0, m[3] ?? 1, 0, m[4] ?? 0, m[5] ?? 0, 1)
}

export type Affine = [number, number, number, number, number, number]

export function multiply(m: readonly number[], n: readonly number[]): Affine {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
	const [p = 1, q = 0, r = 0, s = 1, t = 0, u = 0] = n

	return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f]
}

export function invert(m: readonly number[]): Affine | undefined {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
	const det = a * d - b * c

	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined

	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}
