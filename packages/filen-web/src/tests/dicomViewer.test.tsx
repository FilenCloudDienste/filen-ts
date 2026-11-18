// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { DicomInfo, DicomOpenResult, DicomStatus, DicomTagLevel } from "@/features/preview/lib/dicom/protocol"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { DicomViewer } from "@/features/preview/components/dicomViewer"

// The DICOM viewer's states: the image with its summary, window presets, Invert, Reset, Tags and (multi-frame) the
// scrubber and Page Down; the cards for a file that does not open and for an image it cannot draw, whose tags still
// show.

const remote = vi.hoisted(() => ({
	open: vi.fn<(...args: unknown[]) => Promise<DicomOpenResult>>(),
	show: vi.fn((_frame: number) => Promise.resolve("ok")),
	play: vi.fn(),
	setWindow: vi.fn(),
	setInvert: vi.fn(),
	reset: vi.fn(),
	attach: vi.fn(),
	tags: vi.fn((): Promise<DicomTagLevel> =>
		Promise.resolve({
			rows: [
				{
					tag: "(0010,0010)",
					vr: "PN",
					name: "Patient's Name",
					item: null,
					value: "Doe^Jane",
					length: 8,
					children: 0,
					isPrivate: false
				}
			],
			more: 0
		})
	)
}))
const worker = vi.hoisted(() => ({
	status: "ready",
	generation: 1,
	owned: { run: (call: (api: unknown) => unknown) => Promise.resolve(call(remote)) }
}))
const shellStatus = vi.hoisted(() => ({ push: (_status: DicomStatus): void => undefined }))

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	useOwnedWorker: () => worker
}))
vi.mock("@/features/preview/workers/dicom.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))
const bridge = vi.hoisted(() => {
	const open = () => ({
		channel: { buffer: new SharedArrayBuffer(8), port: new MessageChannel().port1, length: 10 },
		close: vi.fn()
	})

	return { open, openSource: vi.fn(() => Promise.resolve(open())) }
})

vi.mock("@/features/preview/lib/origin/syncSource", () => ({ openOriginSyncSource: bridge.openSource }))
vi.mock("@/features/preview/components/canvasViewerShell", () => ({
	CanvasViewerShell: ({
		toolbar,
		sidePanel,
		notice,
		onStatus
	}: {
		toolbar?: unknown
		sidePanel?: unknown
		notice?: unknown
		onStatus?: (status: DicomStatus) => void
	}) => {
		shellStatus.push = status => {
			onStatus?.(status)
		}

		return (
			<div>
				{notice as never}
				{toolbar as never}
				{sidePanel as never}
			</div>
		)
	}
}))

const INFO: DicomInfo = {
	image: "ok",
	modality: "CT",
	rows: 2,
	columns: 3,
	frames: 1,
	frameTimeMs: 100,
	windowed: true,
	windows: [{ center: 40, width: 400, explanation: null }],
	hounsfield: true
}

// The tag list's virtualizer sizes its viewport off layout, which jsdom leaves 0 (no rows at all).
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute("role") === "tree" ? 600 : 0
		}
	})
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute("role") === "tree" ? 300 : 0
		}
	})
})

afterAll(() => {
	Reflect.deleteProperty(HTMLElement.prototype, "clientHeight")
	Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
})

afterEach(() => {
	cleanup()
})

function renderViewer(result: DicomOpenResult): void {
	remote.open.mockResolvedValue(result)
	render(<DicomViewer item={linkedFileItem("IM0001.dcm")} />)
}

describe("DicomViewer", () => {
	it("draws the image with its summary, presets, Invert, Reset and Tags", async () => {
		renderViewer({ info: INFO, failure: null })

		expect(await screen.findByText("CT · 3×2")).toBeTruthy()
		expect(remote.show).toHaveBeenCalledWith(0)

		for (const name of ["Window: Default", "Invert", "Reset", "Tags"]) {
			expect(screen.getByRole("button", { name }), name).toBeTruthy()
		}

		expect(screen.queryByRole("slider")).toBeNull()

		act(() => {
			shellStatus.push({
				frame: 0,
				window: { center: 40, width: 400 },
				atDefault: false,
				playing: false,
				failure: null,
				reduced: false
			})
		})
		expect(screen.getByText("W 400 L 40")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Window: Soft tissue" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Tags" }))
		expect(await screen.findByText("Doe^Jane")).toBeTruthy()
		expect(screen.getByRole("tree", { name: "DICOM tags" })).toBeTruthy()
	})

	it("steps a multi-frame image with Page Down and the scrubber", async () => {
		renderViewer({ info: { ...INFO, frames: 3 }, failure: null })

		expect(await screen.findByText("CT · 3×2 · 3 frames")).toBeTruthy()
		expect(screen.getByText("1 / 3")).toBeTruthy()

		fireEvent.keyDown(screen.getByRole("button", { name: "Next frame" }), { key: "PageDown", code: "PageDown" })
		await vi.waitFor(() => {
			expect(remote.show).toHaveBeenCalledWith(1)
		})

		fireEvent.click(screen.getByRole("button", { name: "Play" }))
		expect(remote.play).toHaveBeenCalledWith(true)
	})

	it("shows a frame that failed as a notice on a multi-frame image, as a card on a single frame", async () => {
		renderViewer({ info: INFO, failure: null })
		await screen.findByText("CT · 3×2")

		act(() => {
			shellStatus.push({ frame: 0, window: null, atDefault: true, playing: false, failure: "mismatch", reduced: false })
		})
		expect(screen.getByText("Pixel data doesn't match its header.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Tags" })).toBeNull()
	})

	it.each([
		["notDicom", "This file couldn't be read as DICOM."],
		["damaged", "This DICOM file is damaged."],
		["tooLarge", "This file is too large to preview."]
	] as const)("shows the %s card", async (failure, message) => {
		renderViewer({ info: null, failure })

		expect(await screen.findByText(message)).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
	})

	it("offers Try again when the file could not be read", async () => {
		renderViewer({ info: null, failure: "unreadable" })

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
		await vi.waitFor(() => {
			expect(remote.open).toHaveBeenCalledTimes(2)
		})
	})

	it("closes a bridge that opens only once the viewer is gone", async () => {
		const opened = bridge.open()
		let resolve: (value: typeof opened) => void = () => undefined

		bridge.openSource.mockImplementationOnce(
			() =>
				new Promise(done => {
					resolve = done
				})
		)
		remote.open.mockClear()
		render(<DicomViewer item={linkedFileItem("IM0001.dcm")} />)
		await vi.waitFor(() => {
			expect(bridge.openSource).toHaveBeenCalled()
		})
		cleanup()
		resolve(opened)
		await vi.waitFor(() => {
			expect(opened.close).toHaveBeenCalledTimes(1)
		})
		expect(remote.open).not.toHaveBeenCalled()
	})

	it("keeps the tags a button away when the image cannot be drawn", async () => {
		renderViewer({ info: { ...INFO, image: "unsupported" }, failure: null })

		fireEvent.click(await screen.findByRole("button", { name: "Tags" }))
		expect(await screen.findByText("Patient's Name")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Image" }))
		expect(await screen.findByText("This image's encoding can't be shown here.")).toBeTruthy()
	})
})
