// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { LinkedFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import "@/lib/i18n"

// A native image on a phone: one large enough to pass the native view cap is sized from its head first, and one past
// the cap is not handed to the browser unless asked. Desktops and tablets, and smaller files, open as before with
// nothing read ahead.

const { profile, head, reads } = vi.hoisted(() => {
	// The head the byte reader gives.
	const head: { bytes: Uint8Array } = { bytes: new Uint8Array(0) }

	return { profile: { current: null as DeviceProfile | null }, head, reads: { count: 0 } }
})

vi.mock("@/lib/useDeviceProfile", () => ({
	useDeviceProfile: () => {
		if (profile.current === null) throw new Error("no profile")

		return profile.current
	}
}))
vi.mock("@/features/preview/lib/origin/byteReader", () => ({
	openByteReader: () => {
		reads.count++

		return Promise.resolve({ size: head.bytes.length, read: () => Promise.resolve(head.bytes), close: vi.fn() })
	}
}))
vi.mock("@/features/preview/components/streamablePreview", () => ({
	StreamablePreview: () => createElement("p", null, "native image")
}))

const { ImageViewer } = await import("@/features/preview/components/imageViewer")
const { NATIVE_VIEW_SNIFF_FROM_BYTES } = await import("@/lib/pixelBudget")

const BASE: DeviceProfile = {
	heicNative: "unknown",
	jxlNative: "unknown",
	appleMobile: false,
	mobile: false,
	phone: false,
	pdfRangedMax: null
}
const PHONE: DeviceProfile = { ...BASE, mobile: true, phone: true }
const TABLET: DeviceProfile = { ...BASE, mobile: true }

// A PNG's signature and IHDR: all the sniff reads of its size.
function pngHead(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33)
	const view = new DataView(bytes.buffer)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	view.setUint32(16, width)
	view.setUint32(20, height)
	bytes.set([8, 2, 0, 0, 0], 24)

	return bytes
}

function png(uuid: LinkedFile["uuid"], size: number): DriveItem {
	return linkedFileItem("poster.png", { uuid, size: BigInt(size), mime: { Decrypted: "image/png" } })
}

beforeEach(() => {
	reads.count = 0
	head.bytes = pngHead(8000, 8000)
})

afterEach(() => {
	cleanup()
})

describe("a native image's size on a phone", () => {
	it("shows one past the cap as too large, and hands it to the browser only when asked", async () => {
		profile.current = PHONE
		render(
			createElement(ImageViewer, { item: png("eeeeeeee-0000-0000-0000-000000000051", NATIVE_VIEW_SNIFF_FROM_BYTES), alt: "poster" })
		)

		await screen.findByText("This image is too large to display on this device.")
		expect(screen.queryByText("native image")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Open anyway" }))

		await screen.findByText("native image")
		expect(reads.count).toBe(1)
	})

	it("hands one within the cap to the browser", async () => {
		profile.current = PHONE
		head.bytes = pngHead(7000, 7000)
		render(
			createElement(ImageViewer, { item: png("eeeeeeee-0000-0000-0000-000000000052", NATIVE_VIEW_SNIFF_FROM_BYTES), alt: "poster" })
		)

		await screen.findByText("native image")
		expect(reads.count).toBe(1)
	})

	it("reads nothing ahead of a smaller file, or on a tablet or desktop", async () => {
		for (const [current, size] of [
			[PHONE, NATIVE_VIEW_SNIFF_FROM_BYTES - 1],
			[TABLET, 64 * NATIVE_VIEW_SNIFF_FROM_BYTES],
			[BASE, 64 * NATIVE_VIEW_SNIFF_FROM_BYTES]
		] as const) {
			profile.current = current

			const view = render(createElement(ImageViewer, { item: png("eeeeeeee-0000-0000-0000-000000000053", size), alt: "poster" }))

			await screen.findByText("native image")
			view.unmount()
		}

		expect(reads.count).toBe(0)
	})
})
