import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DicomWorkerApi } from "@/features/preview/workers/dicom.worker"
import type { DicomStatus } from "@/features/preview/lib/dicom/protocol"
import { EXPLICIT_LE, dicomFile, grayModule, text } from "@/tests/support/dicomBytes"

// The DICOM worker's own state across files: a second open on the same worker starts from nothing. The canvas, its
// 2D context and the frame clock are stand-ins; the file, its frames and the pipeline are real.

const h = vi.hoisted((): { api: unknown } => ({ api: null }))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		h.api = api
	},
	transfer: <T>(value: T) => value
}))

// What the worker calls on a 2D context, each doing nothing.
const FakeContext = class {
	setTransform = vi.fn()
	clearRect = vi.fn()
	drawImage = vi.fn()
	putImageData = vi.fn()
	imageSmoothingEnabled = false
	imageSmoothingQuality = "low"
}

class FakeCanvas {
	width: number
	height: number

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	getContext(): InstanceType<typeof FakeContext> {
		return new FakeContext()
	}
}

class FakeImageData {
	readonly data: Uint8ClampedArray
	readonly width: number
	readonly height: number

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
		this.data = new Uint8ClampedArray(width * height * 4)
	}
}

// Each test's own (the config unstubs globals after each).
beforeEach(() => {
	vi.stubGlobal("OffscreenCanvas", FakeCanvas)
	vi.stubGlobal("ImageData", FakeImageData)
	vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) =>
		setTimeout(() => {
			callback(performance.now())
		}, 0)
	)
	vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => {
		clearTimeout(handle)
	})
})

await import("@/features/preview/workers/dicom.worker")

const api = h.api as DicomWorkerApi

// A 2×2 CT frame with its own window.
function ct(center: number, width: number): Uint8Array {
	return dicomFile({
		transferSyntax: EXPLICIT_LE,
		elements: [
			text(0x00080060, "CS", "CT"),
			...grayModule({ rows: 2, columns: 2, bitsAllocated: 16, bitsStored: 16, highBit: 15, signed: false }),
			text(0x00281050, "DS", String(center)),
			text(0x00281051, "DS", String(width))
		],
		pixelData: new Uint8Array(8)
	})
}

const frameTurn = () => new Promise(resolve => setTimeout(resolve, 5))

function shellPort(): { port: MessagePort; posted: DicomStatus[] } {
	const posted: DicomStatus[] = []
	const port = {
		postMessage: (message: { type: string; status?: DicomStatus }) => {
			if (message.type === "status" && message.status !== undefined) posted.push(message.status)
		},
		close: () => undefined,
		onmessage: null as ((event: { data: unknown }) => void) | null
	}

	api.attach(port as unknown as MessagePort)
	port.onmessage?.({ data: { type: "canvas", canvas: new FakeCanvas(64, 64), width: 64, height: 64, hidden: false } })

	return { port: port as unknown as MessagePort, posted }
}

describe("the DICOM worker", () => {
	it("starts a second file on the same worker from nothing: its own window, frame and view", async () => {
		const { posted } = shellPort()

		expect(api.open({ kind: "whole", bytes: ct(40, 400) }, { decodeBytes: 64 * 1024 * 1024 }).info?.rows).toBe(2)
		expect(await api.show(0)).toBe("ok")
		api.setWindow({ center: 7, width: 70 })
		await frameTurn()
		expect(posted.at(-1)?.window).toEqual({ center: 7, width: 70 })

		expect(api.open({ kind: "whole", bytes: ct(100, 1000) }, { decodeBytes: 64 * 1024 * 1024 }).info?.rows).toBe(2)
		expect(await api.show(0)).toBe("ok")
		await frameTurn()
		expect(posted.at(-1)).toMatchObject({ window: { center: 100, width: 1000 }, atDefault: true, frame: 0, failure: null })
	})

	it("plays a cine loop through every frame and round again, each next frame decoded ahead of its step", async () => {
		const frames = 4
		const pixels = new Uint8Array(frames * 4).map((_, i) => Math.floor(i / 4) * 60)
		const file = dicomFile({
			transferSyntax: EXPLICIT_LE,
			elements: [
				...grayModule({ rows: 2, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, signed: false, frames }),
				text(0x00181063, "DS", "1")
			],
			pixelData: pixels
		})
		const { posted } = shellPort()

		expect(api.open({ kind: "whole", bytes: file }, { decodeBytes: 64 * 1024 * 1024 }).info?.frames).toBe(frames)
		expect(await api.show(0)).toBe("ok")
		api.play(true)
		await vi.waitFor(
			() => {
				expect(posted.filter(status => status.playing).map(status => status.frame)).toEqual(expect.arrayContaining([1, 2, 3, 0]))
			},
			{ timeout: 2000 }
		)
		api.play(false)
		expect(posted.some(status => status.failure !== null)).toBe(false)
	})
})
