import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesReadRange } from "@filen/shared/videos"
import type { FrameWorkerApi } from "@/features/videos/workers/frame.worker"
import { FPS, GOP_FRAMES, fragmentedMp4, videoPacket } from "@/tests/support/fragmentedMp4"

// The frame worker's single capture on a mediabunny-written fragmented MP4, with WebCodecs and the canvas
// stubbed: which keyframe it decodes, at what size, and that every decoded frame is closed.

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

const stubs = {
	decoded: [] as Uint8Array[],
	frames: [] as FakeFrame[]
}

class FakeDecoder {
	public state = "unconfigured"
	private readonly output: (frame: FakeFrame) => void
	private pending: number[] = []

	public constructor(init: { output: (frame: FakeFrame) => void }) {
		this.output = init.output
	}

	public static isConfigSupported(): Promise<{ supported: boolean }> {
		return Promise.resolve({ supported: true })
	}

	public configure(): void {
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
	stubs.decoded = []
	stubs.frames = []
})

afterEach(() => {
	// Every decoded frame is closed before the call returns.
	expect(stubs.frames.every(frame => frame.closed)).toBe(true)
})

describe("frame worker capture", () => {
	it("captures a still from a fragmented file", async () => {
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
