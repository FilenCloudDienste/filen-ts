import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TextOverlay, VideoEditRecipe } from "@/features/preview/videoEdit/types"
import { VIDEO_FRAGMENTS } from "@/features/preview/videoEdit/gl/shaders"
import { GL_COLOR_GRADE } from "@/lib/gl/colorGrade"

// The frame pass against a recording WebGL 2 stand-in (no GPU in the test runner): what it uploads, draws and
// rasterises per frame, its caching, its context-loss handling and its refusals. The programs themselves are checked
// for how they compose.

const rasterize = vi.hoisted(() => vi.fn())

vi.mock("@/features/preview/videoEdit/gl/textRaster", () => ({ rasterizeText: rasterize }))

const { ContextLostError, HdrPassthroughError, createFramePipeline } = await import("@/features/preview/videoEdit/gl/pipeline")

type Call = [string, ...unknown[]]

class FakeCanvas extends EventTarget {
	public width = 1
	public height = 1
	public gl: ReturnType<typeof fakeGl>

	public constructor() {
		super()
		this.gl = fakeGl()
	}

	public getContext(kind: string): unknown {
		return kind === "webgl2" ? this.gl.context : null
	}

	public transferToImageBitmap(): { width: number; height: number } {
		return { width: this.width, height: this.height }
	}
}

function fakeGl(): { context: unknown; calls: Call[]; lost: { value: boolean }; count: (name: string) => number } {
	const calls: Call[] = []
	const lost = { value: false }
	let ids = 0
	const constants: Record<string, number> = {}
	const context = new Proxy(
		{},
		{
			get: (_target, property: string) => {
				if (/^[A-Z0-9_]+$/.test(property)) {
					constants[property] ??= ++ids

					return constants[property]
				}

				return (...args: unknown[]) => {
					calls.push([property, ...args])

					switch (property) {
						case "isContextLost":
							return lost.value
						case "getShaderParameter":
						case "getProgramParameter":
							return true
						case "getExtension":
							return null
						case "getUniformLocation":
							return { uniform: args[1] }
						default:
							return property.startsWith("create") ? { id: ++ids } : undefined
					}
				}
			}
		}
	)

	return { context, calls, lost, count: name => calls.filter(call => call[0] === name).length }
}

class FakeVideoFrame {
	public readonly source: unknown
	public readonly init: { timestamp: number; duration?: number }

	public constructor(source: unknown, init: { timestamp: number; duration?: number }) {
		this.source = source
		this.init = init
	}
}

function frame(overrides: Partial<VideoFrame> = {}): VideoFrame {
	return {
		displayWidth: 1920,
		displayHeight: 1080,
		codedWidth: 1920,
		codedHeight: 1080,
		visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
		timestamp: 0,
		duration: 33_333,
		format: "I420",
		colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
		...overrides
	} as unknown as VideoFrame
}

function recipe(overrides: Partial<VideoEditRecipe> = {}): VideoEditRecipe {
	return {
		keep: [{ start: 0, end: 10 }],
		crop: null,
		rotate: 0,
		flipH: false,
		flipV: false,
		output: { resolution: "original", quality: "high" },
		audio: { mute: false, gainDb: 0, keepTracks: "first" },
		speed: 1,
		adjust: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, warmth: 0, tint: 0, saturation: 0, vibrance: 0 },
		filter: null,
		text: [],
		precise: false,
		removeLocation: false,
		...overrides
	}
}

function overlay(overrides: Partial<TextOverlay> = {}): TextOverlay {
	return { id: "t1", text: "Hello", startSec: 0, endSec: 5, x: 0.5, y: 0.8, size: 0.05, color: "#ffffff", background: true, ...overrides }
}

let canvas: FakeCanvas

beforeEach(() => {
	canvas = new FakeCanvas()
	vi.stubGlobal("VideoFrame", FakeVideoFrame)
	rasterize.mockReset()
	rasterize.mockImplementation((o: TextOverlay, out: { width: number; height: number }) => ({
		key: JSON.stringify([o.text, o.size, o.color, o.background, out.width, out.height]),
		bitmap: { close: vi.fn() },
		width: 200,
		height: 60
	}))
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function pipeline(): ReturnType<typeof createFramePipeline> {
	return createFramePipeline(canvas as unknown as OffscreenCanvas)
}

describe("createFramePipeline", () => {
	it("uploads the frame once, draws one rectangle and returns a frame of the canvas at the output time", () => {
		const p = pipeline()
		const out = p.render(frame(), recipe({ speed: 2 }), 1280, 720, 3.5, null) as unknown as FakeVideoFrame

		expect(canvas.gl.count("texImage2D")).toBe(1)
		expect(canvas.gl.count("drawArrays")).toBe(1)
		expect(canvas.width).toBe(1280)
		expect(canvas.height).toBe(720)
		expect(out.source).toBe(canvas)
		expect(out.init).toEqual({ timestamp: 3_500_000, duration: 16_667, alpha: "discard" })
	})

	it("builds its programs once and nothing else per frame", () => {
		const p = pipeline()
		const r = recipe({ filter: "warm" })

		p.render(frame(), r, 640, 360, 0, null)

		const programs = canvas.gl.count("createProgram")
		const textures = canvas.gl.count("createTexture")

		for (let i = 0; i < 5; i++) {
			p.render(frame(), r, 640, 360, i / 30, null)
		}

		expect(canvas.gl.count("createProgram")).toBe(programs)
		expect(canvas.gl.count("createTexture")).toBe(textures)
		expect(canvas.gl.count("texImage2D")).toBe(6)
	})

	it("rasterises a text box once, composites it while visible and again only when its content changes", () => {
		const p = pipeline()
		const first = recipe({ text: [overlay()] })

		p.render(frame(), first, 1920, 1080, 1, null)
		p.render(frame(), first, 1920, 1080, 2, null)
		// Moved and retimed: the same raster.
		p.render(frame(), recipe({ text: [overlay({ x: 0.2, endSec: 9 })] }), 1920, 1080, 3, null)

		expect(rasterize).toHaveBeenCalledTimes(1)
		// One frame draw plus one text quad per frame.
		expect(canvas.gl.count("drawArrays")).toBe(6)

		p.render(frame(), recipe({ text: [overlay({ text: "Bye" })] }), 1920, 1080, 3, null)

		expect(rasterize).toHaveBeenCalledTimes(2)
		// The bitmap is closed once its pixels are in a texture.
		for (const result of rasterize.mock.results) {
			expect((result.value as { bitmap: { close: () => void } }).bitmap.close).toHaveBeenCalledTimes(1)
		}
	})

	it("skips a text box outside its time and frees the texture of one removed", () => {
		const p = pipeline()

		p.render(frame(), recipe({ text: [overlay({ startSec: 4 })] }), 1920, 1080, 1, null)

		expect(rasterize).not.toHaveBeenCalled()
		expect(canvas.gl.count("drawArrays")).toBe(1)

		p.render(frame(), recipe({ text: [overlay()] }), 1920, 1080, 1, null)

		const deleted = canvas.gl.count("deleteTexture")

		// Another recipe without the box (a filter thumbnail) keeps its texture: only pruneText frees it.
		p.render(frame(), recipe(), 1920, 1080, 1, null)

		expect(canvas.gl.count("deleteTexture")).toBe(deleted)

		p.render(frame(), recipe({ text: [overlay()] }), 1920, 1080, 1, null)

		expect(rasterize).toHaveBeenCalledTimes(1)

		p.pruneText([overlay()])

		expect(canvas.gl.count("deleteTexture")).toBe(deleted)

		p.pruneText([])

		expect(canvas.gl.count("deleteTexture")).toBe(deleted + 1)
	})

	it("re-rasterises for another output size", () => {
		const p = pipeline()
		const r = recipe({ text: [overlay()] })

		p.render(frame(), r, 1920, 1080, 1, null)
		p.render(frame(), r, 640, 360, 1, null)

		expect(rasterize).toHaveBeenCalledTimes(2)
	})

	it("throws ContextLostError while the context is lost and rebuilds everything after the restore", () => {
		const p = pipeline()
		const r = recipe({ text: [overlay()] })

		p.render(frame(), r, 640, 360, 1, null)

		const event = new Event("webglcontextlost", { cancelable: true })

		canvas.gl.lost.value = true
		canvas.dispatchEvent(event)

		expect(event.defaultPrevented).toBe(true)
		expect(() => p.render(frame(), r, 640, 360, 1, null)).toThrow(ContextLostError)

		const programs = canvas.gl.count("createProgram")

		canvas.gl.lost.value = false
		canvas.dispatchEvent(new Event("webglcontextrestored"))
		p.render(frame(), r, 640, 360, 1, null)

		expect(canvas.gl.count("createProgram")).toBeGreaterThan(programs)
		expect(rasterize).toHaveBeenCalledTimes(2)
	})

	it("refuses HDR it cannot carry and odd sizes", () => {
		const p = pipeline()

		expect(() => p.render(frame(), recipe(), 640, 360, 0, "keep")).toThrow(HdrPassthroughError)
		expect(() => p.render(frame(), recipe(), 640, 360, 0, "hevc10")).toThrow(HdrPassthroughError)
		expect(() => p.render(frame(), recipe(), 0, 360, 0, null)).toThrow(RangeError)
		expect(() => p.render(frame(), recipe(), 640.5, 360, 0, null)).toThrow(RangeError)
	})

	it("tone-maps a 10-bit planar HDR frame from its own planes", async () => {
		const p = pipeline()
		const copyTo = vi.fn(() =>
			Promise.resolve([
				{ offset: 0, stride: 3840 },
				{ offset: 3840 * 1080, stride: 1920 },
				{ offset: 3840 * 1080 + 1920 * 540, stride: 1920 }
			])
		)
		const hdr = frame({
			format: "I420P10",
			colorSpace: { primaries: "bt2020", transfer: "hlg", matrix: "bt2020-ncl", fullRange: false } as unknown as VideoColorSpace,
			allocationSize: () => 3840 * 1080 * 2,
			copyTo
		} as unknown as Partial<VideoFrame>)

		await p.renderAsync(hdr, recipe(), 1280, 720, 0, "toSdr")

		expect(copyTo).toHaveBeenCalledTimes(1)
		expect(canvas.gl.count("texSubImage2D")).toBe(3)
		expect(canvas.gl.count("texImage2D")).toBe(0)

		// The input mode the program got: 2 = HLG.
		const input = canvas.gl.calls.filter(call => call[0] === "uniform1i" && (call[1] as { uniform: string }).uniform === "u_input")

		expect(input.at(-1)?.[2]).toBe(2)

		// SDR frames take the RGB upload even through renderAsync.
		await p.renderAsync(frame(), recipe(), 1280, 720, 0, null)

		expect(canvas.gl.count("texImage2D")).toBe(1)
	})

	it("hands a preview off as a bitmap", () => {
		const p = pipeline()
		const bitmap = p.renderBitmap(frame(), recipe(), 320, 180, 0, null)

		expect(bitmap).toEqual({ width: 320, height: 180 })
	})

	it("tone-maps an HDR preview from the RGB upload, never copying its planes", () => {
		const p = pipeline()
		const copyTo = vi.fn()
		const hdr = frame({
			format: "I420P10",
			colorSpace: { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false } as unknown as VideoColorSpace,
			allocationSize: () => 3840 * 1080 * 2,
			copyTo
		} as unknown as Partial<VideoFrame>)

		p.renderBitmap(hdr, recipe(), 640, 360, 0, "toSdr")

		expect(copyTo).not.toHaveBeenCalled()
		expect(canvas.gl.count("texImage2D")).toBe(1)
		expect(canvas.gl.count("texSubImage2D")).toBe(0)

		const input = canvas.gl.calls.filter(call => call[0] === "uniform1i" && (call[1] as { uniform: string }).uniform === "u_input")

		// 1 = PQ.
		expect(input.at(-1)?.[2]).toBe(1)
	})

	it("loses its context on dispose, even when it never drew", () => {
		const loseContext = vi.fn()
		const context = canvas.gl.context as Record<string, unknown>

		canvas.gl.context = new Proxy(context, {
			get: (target, property: string) =>
				property === "getExtension" ? (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null) : target[property]
		})

		pipeline().dispose()

		expect(loseContext).toHaveBeenCalledTimes(1)
	})

	it("answers needsGpu like needsGpuPass", () => {
		const p = pipeline()

		expect(p.needsGpu(recipe())).toBe(false)
		expect(p.needsGpu(recipe({ rotate: 90 }))).toBe(false)
		expect(p.needsGpu(recipe({ flipH: true }))).toBe(true)
	})

	it("refuses to render after dispose", () => {
		const p = pipeline()

		p.render(frame(), recipe(), 64, 36, 0, null)
		p.dispose()

		expect(() => p.render(frame(), recipe(), 64, 36, 0, null)).toThrow(/disposed/)
	})
})

describe("frame pass programs", () => {
	function uniforms(source: string): string[] {
		return [...source.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map(match => match[1] ?? "")
	}

	it("declare every uniform once, u_outSize before the grade, and include the shared grade once", () => {
		for (const source of [VIDEO_FRAGMENTS.frame, VIDEO_FRAGMENTS.planes]) {
			const declared = uniforms(source)

			expect(new Set(declared).size).toBe(declared.length)
			expect(source.split(GL_COLOR_GRADE)).toHaveLength(2)
			expect(source.indexOf("uniform vec2 u_outSize;")).toBeLessThan(source.indexOf(GL_COLOR_GRADE))
		}

		expect(VIDEO_FRAGMENTS.text).not.toContain("grade(")
	})
})
