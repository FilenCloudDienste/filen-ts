import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BufferSource, Input, MP4 } from "mediabunny"
import type { VideoEditRecipe } from "@/features/preview/videoEdit/types"
import type { PreviewWorkerApi } from "@/features/preview/videoEdit/worker/preview.worker"
import { fragmentedMp4 } from "@/tests/support/fragmentedMp4"
import { recipeFor } from "@/tests/support/videoEditRecipe"

// The preview worker's own surface over a real demuxer: filter thumbnails (one decode, a pass per filter, their own
// supersede counter, behind stage frames), the stage's text textures, and the worker-wide decoder suspension. The
// decoder and the GPU pass are stand-ins, tested on their own.

const h = vi.hoisted(() => ({
	expose: vi.fn(),
	decodes: [] as { time: number; current: () => boolean; gate: PromiseWithResolvers<undefined> }[],
	released: 0,
	renders: [] as { filter: string | null; text: number; width: number; height: number }[],
	pruned: [] as number[],
	source: { bytes: null as Uint8Array | null }
}))

// The fixture file (made before the worker module loads).
function sourceBytes(): Uint8Array {
	if (h.source.bytes === null) {
		throw new Error("no fixture yet")
	}

	return h.source.bytes
}

vi.mock("comlink", () => ({
	expose: h.expose,
	transfer: <T>(value: T) => value,
	releaseProxy: Symbol("releaseProxy")
}))

vi.mock("@/lib/media/blockInput", () => ({
	openBlockInput: () => ({
		input: new Input({ formats: [MP4], source: new BufferSource(sourceBytes()) }),
		cache: { size: sourceBytes().length, read: (start: number, end: number) => sourceBytes().subarray(start, end) },
		close: vi.fn()
	})
}))

vi.mock("@/features/preview/videoEdit/worker/preview.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/videoEdit/worker/preview.logic")>()

	// No WebCodecs in the test runner: the source is taken as decodable.
	return {
		...actual,
		sourceInfo: (...args: Parameters<typeof actual.sourceInfo>) => ({ ...actual.sourceInfo(...args), previewable: true })
	}
})

vi.mock("@/features/preview/videoEdit/worker/gopDecoder", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/videoEdit/worker/gopDecoder")>()

	class FakeGopDecoder {
		public async frameAt(time: number, current: () => boolean): Promise<VideoFrame> {
			const gate = Promise.withResolvers<undefined>()

			h.decodes.push({ time, current, gate })
			await gate.promise

			if (!current()) {
				throw new actual.SupersededError()
			}

			return { timestamp: time * 1e6, close: vi.fn() } as unknown as VideoFrame
		}

		public release(): void {
			h.released++
		}

		public close(): void {
			h.released++
		}
	}

	return { ...actual, GopDecoder: FakeGopDecoder }
})

vi.mock("@/features/preview/videoEdit/gl/pipeline", () => ({
	createFramePipeline: () => ({
		renderBitmap: (_frame: VideoFrame, recipe: VideoEditRecipe, width: number, height: number) => {
			h.renders.push({ filter: recipe.filter, text: recipe.text.length, width, height })

			return { width, height, close: vi.fn() }
		},
		pruneText: (overlays: readonly unknown[]) => {
			h.pruned.push(overlays.length)
		},
		dispose: vi.fn()
	})
}))

vi.mock("@/features/preview/videoEdit/worker/waveform", () => ({
	WaveformTap: class {
		public start = vi.fn()
		public close = vi.fn()
	}
}))

class FakeCanvas {
	public width: number
	public height: number

	public constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}
}

let api: PreviewWorkerApi

const TEXT = { id: "t", text: "Hi", startSec: 0, endSec: 9, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }

beforeAll(async () => {
	h.source.bytes = await fragmentedMp4({ seconds: 4, audio: false, fastStart: "in-memory" })
	await import("@/features/preview/videoEdit/worker/preview.worker")
	api = h.expose.mock.calls[0]?.[0] as PreviewWorkerApi
})

beforeEach(async () => {
	vi.stubGlobal("OffscreenCanvas", FakeCanvas)
	h.decodes.length = 0
	h.renders.length = 0
	h.pruned.length = 0
	api.resumeDecoding()
	await api.open({ port: {} as MessagePort, size: sourceBytes().length, probe: null })
})

afterEach(() => {
	api.close()
})

// Lets the pending decode at `index` answer once it was asked.
async function answer(index: number): Promise<void> {
	await vi.waitFor(() => {
		expect(h.decodes[index]).toBeDefined()
	})
	h.decodes[index]?.gate.resolve(undefined)
}

describe("preview worker", () => {
	it("decodes once and draws one thumbnail per filter, without the text boxes", async () => {
		const recipe = recipeFor(4, { text: [TEXT] })
		const pending = api.filterThumbnails(1, recipe, [null, "vivid", "mono"], 64)

		await answer(0)

		const thumbnails = await pending

		expect(h.decodes).toHaveLength(1)
		expect(thumbnails.map(thumbnail => thumbnail.filter)).toEqual([null, "vivid", "mono"])
		expect(h.renders.map(render => render.filter)).toEqual([null, "vivid", "mono"])
		expect(h.renders.every(render => render.text === 0 && render.height <= 64)).toBe(true)
		// Thumbnails never prune the stage's text textures.
		expect(h.pruned).toEqual([])
	})

	it("never lets thumbnails and stage frames supersede each other; a newer thumbnail call supersedes an older", async () => {
		const recipe = recipeFor(4, { text: [TEXT] })
		const stage = api.frameAt(1, recipe, 640)

		// Stage first; the thumbnail call waits behind it.
		const thumbnails = api.filterThumbnails(1, recipe, [null], 64)

		await answer(0)

		expect((await stage).width).toBeGreaterThan(0)
		// The stage's own text boxes are kept, by id.
		expect(h.pruned).toEqual([1])

		await answer(1)

		expect(await thumbnails).toHaveLength(1)

		const older = api.filterThumbnails(2, recipe, [null], 64)

		await vi.waitFor(() => {
			expect(h.decodes[2]).toBeDefined()
		})

		const newer = api.filterThumbnails(2, recipe, ["vivid"], 64)

		h.decodes[2]?.gate.resolve(undefined)
		await expect(older).rejects.toMatchObject({ name: "AbortError" })
		await answer(3)
		expect((await newer)[0]?.filter).toBe("vivid")
	})

	it("steps a thumbnail decode aside for a stage frame and resumes it after", async () => {
		const recipe = recipeFor(4)
		const thumbnails = api.filterThumbnails(1, recipe, [null], 64)

		await vi.waitFor(() => {
			expect(h.decodes[0]).toBeDefined()
		})

		const stage = api.frameAt(3, recipe, 640)

		// A stage frame is waiting: the thumbnail's decode is no longer current, and stops.
		expect(h.decodes[0]?.current()).toBe(false)
		h.decodes[0]?.gate.resolve(undefined)
		await answer(1)
		expect(await stage).toBeDefined()
		await answer(2)
		expect(await thumbnails).toHaveLength(1)
		expect(h.decodes.map(decode => decode.time)).toEqual([1, 3, 1])
	})

	it("opens a source suspended while decoding is suspended, until resumed", async () => {
		api.suspendDecoding()
		api.close()
		await api.open({ port: {} as MessagePort, size: sourceBytes().length, probe: null })

		await expect(api.frameAt(1, recipeFor(4), 640)).rejects.toMatchObject({ name: "AbortError" })
		await expect(api.filterThumbnails(1, recipeFor(4), [null], 64)).rejects.toMatchObject({ name: "AbortError" })
		expect(h.decodes).toEqual([])

		api.resumeDecoding()

		const frame = api.frameAt(1, recipeFor(4), 640)

		await answer(0)
		expect(await frame).toBeDefined()
	})
})
