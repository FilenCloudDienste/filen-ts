// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AnyFile, LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import "@/lib/i18n"

// A HEIC where the browser decodes HEIC itself: the viewer streams it through the service worker like any image, and
// tells a decode failure from a network one by the worker's delivery acknowledgement. A failure after every byte
// arrived goes to libheif without retrying the stream; one without it keeps the stream's buffered retry, whose own
// decode failure then goes to libheif on the bytes it holds.

const { downloadFileBytes, registerWithSw, transformHeicBytes, probeNativeImage, controller } = vi.hoisted(() => ({
	// Whether the controlling worker speaks this page's protocol (it answers status queries).
	controller: { current: false },
	downloadFileBytes: vi.fn<(file: AnyFile, token: string) => Promise<Uint8Array>>(),
	registerWithSw: vi.fn<(type: string, payload: Record<string, unknown>) => Promise<void>>(),
	transformHeicBytes: vi.fn<(bytes: Uint8Array) => Promise<Blob>>(),
	probeNativeImage: vi.fn<(format: string) => Promise<boolean>>()
}))

vi.mock("@/lib/sdk/client", async () => {
	const { originShims } = await import("@/tests/support/originShims")

	return {
		sdkApi: { downloadFileBytes, cancelPreviewDownload: vi.fn(), ...originShims({ downloadFileBytes }) },
		threadCount: () => 1
	}
})
vi.mock("@/features/drive/lib/saveDownload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()),
	registerWithSw
}))
vi.mock("@/features/preview/lib/rasterDecode", () => ({ transformHeicBytes, transformHeicBytesOwned: transformHeicBytes }))
vi.mock("@/lib/nativeImageSupport", () => ({ probeNativeImage }))
vi.mock("@/lib/sw/register", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/sw/register")>()),
	controllerIsCurrent: () => Promise.resolve(controller.current)
}))

const { ImageViewer } = await import("@/features/preview/components/imageViewer")
const { clearPreviewCache } = await import("@/features/preview/lib/previewCache")
const { refineDeviceProfile } = await import("@/lib/deviceProfile")
const { SW_MSG_PREVIEW_DELIVERED, SW_MSG_PREVIEW_STATUS } = await import("@/lib/sw/protocol")

// One container for the file: the page listens on it from its first registration on. Its worker says every
// registration is still served.
const container = Object.assign(new EventTarget(), {
	controller: {
		postMessage: vi.fn((message: { type?: unknown }, ports?: MessagePort[]) => {
			if (message.type === SW_MSG_PREVIEW_STATUS) {
				ports?.[0]?.postMessage({ status: "present" })
			}
		})
	}
})

function deliver(id: string): void {
	container.dispatchEvent(new MessageEvent("message", { data: { type: SW_MSG_PREVIEW_DELIVERED, id } }))
}

let objectUrls = 0

function heic(uuid: LinkedFile["uuid"], size: number): DriveItem {
	return linkedFileItem("photo.heic", { uuid, size: BigInt(size), mime: { Decrypted: "image/heic" } })
}

function picture(): HTMLImageElement {
	return screen.getByRole<HTMLImageElement>("img", { name: "photo" })
}

async function streamed(): Promise<{ image: HTMLImageElement; id: string }> {
	const image = await waitFor(() => {
		const element = picture()

		expect(element.getAttribute("src")).toMatch(/^\/sw\/download\//)

		return element
	})
	const src = image.getAttribute("src") ?? ""

	return { image, id: src.slice(src.lastIndexOf("/") + 1) }
}

beforeAll(() => {
	Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container })
})

beforeEach(() => {
	clearPreviewCache()
	vi.clearAllMocks()
	downloadFileBytes.mockImplementation(file => Promise.resolve(new Uint8Array(Number(file.size)).fill(7)))
	registerWithSw.mockResolvedValue(undefined)
	transformHeicBytes.mockResolvedValue(new Blob(["jpeg"]))
	URL.createObjectURL = vi.fn(() => `blob:test-${String(++objectUrls)}`)
	URL.revokeObjectURL = vi.fn()
	refineDeviceProfile({ heicNative: "yes" })
	controller.current = false
})

afterEach(() => {
	cleanup()
	refineDeviceProfile({ heicNative: "unknown" })
})

describe("ImageViewer on a HEIC the browser decodes", () => {
	it("streams it as image/heic, and a decode failure after every byte arrived goes to libheif with one download", async () => {
		render(createElement(ImageViewer, { item: heic("eeeeeeee-0000-0000-0000-000000000001", 10), alt: "photo" }))

		const { image, id } = await streamed()

		expect(registerWithSw.mock.calls[0]?.[1]["contentType"]).toBe("image/heic")

		deliver(id)
		fireEvent.error(image)

		await waitFor(() => {
			expect(transformHeicBytes).toHaveBeenCalledOnce()
			expect(picture().getAttribute("src")).toMatch(/^blob:/)
		})
		expect(downloadFileBytes).toHaveBeenCalledOnce()
	})

	it("retries a failure with no acknowledgement buffered, and sends that copy's decode failure to libheif without downloading again", async () => {
		render(createElement(ImageViewer, { item: heic("eeeeeeee-0000-0000-0000-000000000002", 10), alt: "photo" }))

		const { image } = await streamed()

		fireEvent.error(image)

		const buffered = await waitFor(
			() => {
				const element = picture()

				expect(element.getAttribute("src")).toMatch(/^blob:/)

				return element
			},
			{ timeout: 3_000 }
		)

		expect(downloadFileBytes).toHaveBeenCalledOnce()
		expect(transformHeicBytes).not.toHaveBeenCalled()

		fireEvent.error(buffered)

		await waitFor(() => {
			expect(transformHeicBytes).toHaveBeenCalledOnce()
		})
		expect(downloadFileBytes).toHaveBeenCalledOnce()
	})

	it("registers every open under an id of its own, so a copy the browser kept never stands in for a delivery", async () => {
		const item = heic("eeeeeeee-0000-0000-0000-000000000005", 10)
		const first = render(createElement(ImageViewer, { item, alt: "photo" }))
		const { id } = await streamed()

		deliver(id)
		first.unmount()
		render(createElement(ImageViewer, { item, alt: "photo" }))

		const again = await streamed()

		expect(again.id).not.toBe(id)
		expect(registerWithSw.mock.calls[1]?.[1]["id"]).toBe(again.id)
	})

	it("waits for an acknowledgement that lands late while the worker still serves the stream", async () => {
		controller.current = true
		render(createElement(ImageViewer, { item: heic("eeeeeeee-0000-0000-0000-000000000006", 10), alt: "photo" }))

		const { image, id } = await streamed()

		fireEvent.error(image)
		await new Promise(resolve => setTimeout(resolve, 1_300))
		deliver(id)

		await waitFor(() => {
			expect(transformHeicBytes).toHaveBeenCalledOnce()
			expect(picture().getAttribute("src")).toMatch(/^blob:/)
		})
		expect(downloadFileBytes).toHaveBeenCalledOnce()
	})

	it("says the picture cannot be displayed when its decode failed and it is too large to convert", async () => {
		render(createElement(ImageViewer, { item: heic("eeeeeeee-0000-0000-0000-000000000003", 300 * 1024 * 1024), alt: "photo" }))

		const { image, id } = await streamed()

		deliver(id)
		fireEvent.error(image)

		expect(await screen.findByText("This image can't be displayed in this browser.")).toBeDefined()
		expect(downloadFileBytes).not.toHaveBeenCalled()
		expect(transformHeicBytes).not.toHaveBeenCalled()
	})

	it("waits for the probe on a HEIC opened before it answered, then routes by its answer", async () => {
		refineDeviceProfile({ heicNative: "unknown" })

		const answer = Promise.withResolvers<boolean>()

		probeNativeImage.mockReturnValue(answer.promise)
		render(createElement(ImageViewer, { item: heic("eeeeeeee-0000-0000-0000-000000000004", 10), alt: "photo" }))

		await waitFor(() => {
			expect(probeNativeImage).toHaveBeenCalledWith("heic")
		})
		expect(screen.queryByRole("img")).toBeNull()

		await act(async () => {
			refineDeviceProfile({ heicNative: "yes" })
			answer.resolve(true)
			await answer.promise
		})

		await streamed()
		expect(downloadFileBytes).not.toHaveBeenCalled()
		expect(transformHeicBytes).not.toHaveBeenCalled()
	})
})
