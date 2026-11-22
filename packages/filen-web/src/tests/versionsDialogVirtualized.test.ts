// @vitest-environment jsdom

// A file with hundreds of versions mounts a window of them, and every one stays reachable and selectable.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, FileVersion } from "@filen/sdk-rs"
import "@/lib/i18n"
import { stubElementSize } from "@/tests/stubElementSize"

const COUNT = 400

const { versions } = vi.hoisted(() => {
	const count = 400

	return {
		versions: Array.from({ length: count }, (_, index): FileVersion => ({
			uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			stableUUID: "55555555-5555-5555-5555-555555555555",
			region: "de-1",
			bucket: "filen-1",
			chunks: 1n,
			timestamp: 1_600_000_000_000n - BigInt(index) * 60_000n,
			size: BigInt(index + 1),
			metadata: {
				type: "decoded",
				data: { name: "report.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "key", version: 2 }
			}
		}))
	}
})

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useFileVersionsQuery: () => ({ status: "success", data: versions })
}))

import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { narrowItem } from "@/features/drive/lib/item"
import { type FileItem } from "@/features/drive/lib/actions"

function asFileItem(source: File): FileItem {
	const item = narrowItem(source)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

const file = asFileItem({
	uuid: "22222222-2222-2222-2222-222222222222",
	stableUUID: "55555555-5555-5555-5555-555555555555",
	parent: "33333333-3333-3333-3333-333333333333",
	size: 1_024n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 1_700_000_000_000n,
	chunks: 1n,
	canMakeThumbnail: true,
	meta: {
		type: "decoded",
		data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
	}
})

let restoreSize: () => void = () => undefined
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 400, clientWidth: 400 })
	// Rows are measured, and jsdom measures every box as empty: each one reports a real row's height.
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 52 })
})

afterAll(() => {
	restoreSize()

	if (offsetHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight)
	}
})

afterEach(cleanup)

function rows(): HTMLElement[] {
	return screen.getAllByRole("listitem")
}

describe("VersionsDialog with many versions", () => {
	it("mounts a window of the rows, each placed among all of them", () => {
		render(createElement(VersionsDialog, { file, onClose: vi.fn() }))

		expect(rows().length).toBeGreaterThan(0)
		expect(rows().length).toBeLessThan(40)
		expect(rows()[0]?.getAttribute("aria-setsize")).toBe(String(COUNT))
	})

	it("reaches the oldest version by scrolling, and selects it", () => {
		render(createElement(VersionsDialog, { file, onClose: vi.fn() }))
		fireEvent.click(screen.getByRole("button", { name: "Select" }))

		const scroller = rows()[0]?.closest("ul")?.parentElement

		if (scroller === null || scroller === undefined) {
			throw new Error("no scroller")
		}

		act(() => {
			scroller.scrollTop = COUNT * 56
			scroller.dispatchEvent(new Event("scroll"))
		})

		const last = rows().find(row => row.getAttribute("aria-posinset") === String(COUNT))
		const toggle = last?.querySelector("button")

		if (toggle === null || toggle === undefined) {
			throw new Error("oldest version not mounted")
		}

		expect(toggle.getAttribute("aria-pressed")).toBe("false")

		fireEvent.click(toggle)

		expect(toggle.getAttribute("aria-pressed")).toBe("true")
		expect(screen.getByText("1 selected")).toBeTruthy()
	})
})
