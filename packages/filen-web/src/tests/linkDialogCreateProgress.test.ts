// @vitest-environment jsdom

// Making a directory link shows its two phases under the Enable button: reading the tree (a bar once its
// size is known), then the items linked.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { DirectoryProgress } from "@/features/drive/lib/directoryProgress"
import "@/lib/i18n"

const { createLink } = vi.hoisted(() => ({ createLink: vi.fn() }))

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ Link: () => null }))
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined, desktopPlatform: () => undefined }))
vi.mock("@/queries/account", () => ({
	useAccountQuery: () => ({ status: "success", data: { subs: [{ activated: true }] }, error: null, refetch: vi.fn() })
}))
vi.mock("@/features/drive/lib/actions", () => ({ createLink, disableLink: vi.fn(), updateLink: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDriveItemLinkStatusQuery: () => ({ status: "success", data: null })
}))

import { LinkDialog } from "@/features/drive/components/linkDialog"
import { mockDirItem, mockFileItem } from "@/tests/fixtures/sdk"

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function bar(): HTMLElement {
	return screen.getByRole("progressbar")
}

describe("LinkDialog directory link progress", () => {
	it("reads the directory, then counts the items linked", () => {
		let report: (progress: DirectoryProgress) => void = () => undefined

		createLink.mockImplementation((_item: unknown, onProgress: (progress: DirectoryProgress) => void) => {
			report = onProgress

			return new Promise(() => undefined)
		})
		render(createElement(LinkDialog, { item: mockDirItem(), onClose: vi.fn() }))

		fireEvent.click(screen.getByRole("button", { name: "Create public link" }))

		// Before the SDK reports anything: reading, size unknown.
		expect(screen.getByText("Reading directory…")).toBeTruthy()
		expect(bar().getAttribute("aria-valuenow")).toBeNull()

		act(() => {
			report({ phase: "reading", fraction: 0.5 })
		})

		expect(screen.getByText("Reading directory…")).toBeTruthy()
		expect(bar().getAttribute("aria-valuenow")).toBe("50")

		act(() => {
			report({ phase: "items", done: 3, total: 12 })
		})

		expect(screen.queryByText("Reading directory…")).toBeNull()
		expect(screen.getByText("Linking 3 of 12 items")).toBeTruthy()
		expect(bar().getAttribute("aria-valuenow")).toBe("25")
	})

	it("shows no phases for a file link", () => {
		createLink.mockReturnValue(new Promise(() => undefined))
		render(createElement(LinkDialog, { item: mockFileItem(), onClose: vi.fn() }))

		fireEvent.click(screen.getByRole("button", { name: "Create public link" }))

		expect(screen.queryByText("Reading directory…")).toBeNull()
		expect(screen.queryByRole("progressbar")).toBeNull()
	})
})
