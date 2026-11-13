import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesReadRange } from "@filen/shared/videos"
import { FRAME_BATCH_MAX_FRAMES, frameBitmapSize, planFrameBatch } from "@/features/videos/lib/frameBatch.logic"
import type { FrameBatchParams, FrameBatchResult, FrameWorkerApi } from "@/features/videos/workers/frame.worker"
import { FPS, GOP_FRAMES, fragmentedMp4, videoPacket } from "@/tests/support/fragmentedMp4"

// The frame worker's batch API on a mediabunny-written fragmented MP4, with WebCodecs and the bitmap calls
// stubbed: what it decodes, in what order, at what size, and that every frame and unused bitmap is closed.

const exposed: { api: FrameWorkerApi | null } = { api: null }
const files: { bytes: Uint8Array } = { bytes: new Uint8Array() }

vi.mock("comlink", () => ({
	expose: (api: FrameWorkerApi) => {
		exposed.api = api
	},
	transfer: (value: unknown) => value
}))

vi.mock("@/lib/media/rangePort", () => ({
	rangePortReader: () => {
		const read = bytesReadRange(files.bytes)

		return {
			readRange: (start: number, end: number, signal: AbortSignal) =>
				signal.aborted ? Promise.reject(new Error("aborted")) : read(start, end),
			close: () => undefined
		}
	}
}))

interface FakeFrame {
	codedWidth: number
	codedHeight: number
	visibleRect: { width: number; height: number }
	timestamp: number
	close: () => void
	closed: boolean
}

interface FakeBitmap {
	width: number
	height: number
	close: () => void
	closed: boolean
}

const stubs = {
	decoders: 0,
	configures: 0,
	decoded: [] as Uint8Array[],
	frames: [] as FakeFrame[],
	bitmaps: [] as FakeBitmap[],
	onBitmap: null as (() => void) | null
}

class FakeDecoder {
	public state = "unconfigured"
	private readonly output: (frame: FakeFrame) => void
	private pending: number[] = []

	public constructor(init: { output: (frame: FakeFrame) => void }) {
		stubs.decoders++
		this.output = init.output
	}

	public static isConfigSupported(): Promise<{ supported: boolean }> {
		return Promise.resolve({ supported: true })
	}

	public configure(): void {
		stubs.configures++
		this.state = "configured"
	}

	public decode(chunk: { data: Uint8Array; timestamp: number }): void {
		stubs.decoded.push(chunk.data)
		this.pending.push(chunk.timestamp)
	}

	public flush(): Promise<void> {
		for (const timestamp of this.pending) {
			const frame: FakeFrame = {
				codedWidth: 1280,
				codedHeight: 720,
				visibleRect: { width: 1280, height: 720 },
				timestamp,
				closed: false,
				close: () => {
					frame.closed = true
				}
			}

			stubs.frames.push(frame)
			this.output(frame)
		}

		this.pending = []

		return Promise.resolve()
	}

	public close(): void {
		this.state = "closed"
	}
}

class FakeChunk {
	public readonly data: Uint8Array
	public readonly timestamp: number

	public constructor(init: { data: Uint8Array; timestamp: number }) {
		this.data = init.data
		this.timestamp = init.timestamp
	}
}

class FakeCanvas {
	public width: number
	public height: number

	public constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	public getContext(): object {
		return {
			drawImage: () => undefined,
			translate: () => undefined,
			rotate: () => undefined,
			// Mid-grey: not dark, so a single capture takes its first position.
			getImageData: (_x: number, _y: number, width: number, height: number) => ({
				data: new Uint8ClampedArray(width * height * 4).fill(128)
			})
		}
	}

	public convertToBlob(options: { type: string }): Promise<Blob> {
		return Promise.resolve(new Blob([new Uint8Array(16)], { type: options.type }))
	}
}

let api: FrameWorkerApi

// The config unstubs globals after every test, so each test (and the import) stubs them again.
function stubWebCodecs(): void {
	vi.stubGlobal("VideoDecoder", FakeDecoder)
	vi.stubGlobal("EncodedVideoChunk", FakeChunk)
	vi.stubGlobal("OffscreenCanvas", FakeCanvas)
	vi.stubGlobal("createImageBitmap", (_frame: FakeFrame, options: { resizeWidth: number; resizeHeight: number }) => {
		const bitmap: FakeBitmap = {
			width: options.resizeWidth,
			height: options.resizeHeight,
			closed: false,
			close: () => {
				bitmap.closed = true
			}
		}

		stubs.bitmaps.push(bitmap)
		stubs.onBitmap?.()

		return Promise.resolve(bitmap)
	})
}

beforeAll(async () => {
	stubWebCodecs()

	await import("@/features/videos/workers/frame.worker")

	if (exposed.api === null) {
		throw new Error("worker exposed nothing")
	}

	api = exposed.api
	files.bytes = await fragmentedMp4({ seconds: 10, audio: true, expectedDuration: 10 })
})

beforeEach(() => {
	stubWebCodecs()
	stubs.decoders = 0
	stubs.configures = 0
	stubs.decoded = []
	stubs.frames = []
	stubs.bitmaps = []
	stubs.onBitmap = null
})

afterEach(() => {
	// Every decoded frame is closed before the call returns.
	expect(stubs.frames.every(frame => frame.closed)).toBe(true)
})

function params(overrides: Partial<FrameBatchParams> = {}): FrameBatchParams {
	return {
		id: 1,
		port: {} as MessagePort,
		size: files.bytes.length,
		maxReads: 16,
		positions: [0.5, 1, 5, 9.5, 3],
		maxFrames: 8,
		par: 1,
		rotation: 0,
		box: { width: 160, height: 160 },
		...overrides
	}
}

function frames(result: FrameBatchResult) {
	if (result.type !== "frames") {
		throw new Error(`expected frames, got ${result.type}`)
	}

	return result
}

describe("frame worker captureMany", () => {
	it("decodes each distinct keyframe once, in file order, with one decoder", async () => {
		const result = frames(await api.captureMany(params()))

		expect(stubs.decoders).toBe(1)
		expect(stubs.configures).toBe(1)
		expect(stubs.decoded).toEqual([0, 2, 4, 8].map(second => videoPacket(second * FPS)))
		expect(result.frames.map(frame => [frame.timeSec, frame.positions])).toEqual([
			[0, [0, 1]],
			[2, [4]],
			[4, [2]],
			[8, [3]]
		])
		expect(result.skipped).toEqual([])
		expect(result.frames.map(frame => [frame.bitmap.width, frame.bitmap.height])).toEqual(new Array(4).fill([160, 90]))
		expect(stubs.bitmaps.every(bitmap => !bitmap.closed)).toBe(true)
	})

	it("stops at the frame cap and reports the positions left over", async () => {
		const result = frames(await api.captureMany(params({ maxFrames: 2 })))

		expect(result.frames.map(frame => frame.timeSec)).toEqual([0, 4])
		expect(result.skipped).toEqual([3, 4])
		expect(stubs.decoded.length).toBe(2)
	})

	it("cancels between keyframes and closes the stills already made", async () => {
		stubs.onBitmap = () => {
			api.cancelBatch(7)
		}

		const result = await api.captureMany(params({ id: 7 }))

		expect(result.type).toBe("cancelled")
		expect(stubs.decoded.length).toBe(1)
		expect(stubs.bitmaps.every(bitmap => bitmap.closed)).toBe(true)
	})

	it("returns the stills the read budget allowed and asks for the rest again", async () => {
		const small = files.bytes

		// About 1 MiB per GOP, so each keyframe's fragment is a download of its own.
		files.bytes = await fragmentedMp4({ seconds: 10, audio: false, expectedDuration: 10, padding: 20_000 })

		try {
			const result = frames(await api.captureMany(params({ size: files.bytes.length, maxReads: 3 })))

			expect(result.frames.length).toBeGreaterThan(0)
			expect(result.skipped.length).toBeGreaterThan(0)
			expect(result.reads).toBeLessThanOrEqual(3)
			expect(stubs.decoded).toEqual(result.frames.map(frame => videoPacket(frame.timeSec * FPS, 20_000)))
		} finally {
			files.bytes = small
		}
	})

	it("keeps the single capture working, now on a fragmented file", async () => {
		const result = await api.capture({
			port: {} as MessagePort,
			size: files.bytes.length,
			maxReads: 8,
			known: null,
			par: 1,
			rotation: 0,
			box: { width: 320, height: 180 }
		})

		expect(result.type).toBe("frame")

		if (result.type === "frame") {
			// The first position (18% of 10 s) falls in the GOP that starts at 0.
			expect(result.key.timeSec).toBe(0)
			expect([result.width, result.height]).toEqual([320, 180])
		}

		expect(stubs.decoded).toEqual([videoPacket(0)])
		expect(GOP_FRAMES).toBe(2 * FPS)
	})
})

describe("batch planning", () => {
	const ref = (offset: number, timeSec: number) => ({ offset, size: 10, timeSec })

	it("shares slots between positions of one keyframe and orders them by offset", () => {
		const plan = planFrameBatch([ref(500, 4), null, ref(100, 0), ref(500, 4), ref(300, 2)], 8)

		expect(plan.slots.map(slot => [slot.ref.offset, slot.positions])).toEqual([
			[100, [2]],
			[300, [4]],
			[500, [0, 3]]
		])
		expect(plan.skipped).toEqual([1])
	})

	it("never plans more than the batch cap", () => {
		const refs = Array.from({ length: FRAME_BATCH_MAX_FRAMES + 5 }, (_, i) => ref(i * 10, i))

		expect(planFrameBatch(refs, 1000).slots.length).toBe(FRAME_BATCH_MAX_FRAMES)
		expect(planFrameBatch(refs, 0).slots.length).toBe(0)
	})

	it("sizes bitmaps as displayed but unturned", () => {
		expect(frameBitmapSize({ width: 1920, height: 1080 }, 1, 0, { width: 160, height: 160 })).toEqual({ width: 160, height: 90 })
		// Shown portrait (90x160 inside the box), made landscape for the drawer to turn.
		expect(frameBitmapSize({ width: 1920, height: 1080 }, 1, 90, { width: 160, height: 160 })).toEqual({ width: 160, height: 90 })
		expect(frameBitmapSize({ width: 1920, height: 1080 }, 1, 90, { width: 45, height: 80 })).toEqual({ width: 80, height: 45 })
		// Anamorphic: 720x576 at 64:45 shows 1024x576.
		expect(frameBitmapSize({ width: 720, height: 576 }, 64 / 45, 0, { width: 256, height: 256 })).toEqual({ width: 256, height: 144 })
	})
})
