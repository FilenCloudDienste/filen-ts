// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { DirPublicInfo, DirPublicLink, LinkedDir } from "@filen/sdk-rs"
import type { AnonDownloadOutcome, AnonDownloadProgress } from "@/features/publicLinks/lib/download"
import { mockViewportHeight } from "@/tests/support/viewport"
import "@/lib/i18n"

// The directory link's landmarks and announcements: a named breadcrumb marking the level on screen, a named
// progress bar, and outcomes a screen reader hears.

const { startAnonDirZipDownload } = vi.hoisted(() => ({
	startAnonDirZipDownload: vi.fn<(options: { onProgress: AnonDownloadProgress }) => Promise<AnonDownloadOutcome>>()
}))

vi.mock("@/features/publicLinks/lib/download", () => ({
	startAnonDirZipDownload,
	startAnonFileDownload: vi.fn(),
	startAnonItemsZipDownload: vi.fn()
}))
vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: () => false,
	usePublicDirListing: () => ({ status: "success", data: LISTING, refetch: vi.fn() }),
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false })
}))
vi.mock("@/features/publicLinks/components/fileHero", () => ({ FileHero: () => null }))
vi.mock("@/features/publicLinks/components/saveToDrive", () => ({ SaveToDriveButton: () => null, SaveToDriveDialog: () => null }))

import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

const ROOT_UUID = "d1000000-0000-0000-0000-000000000000"
const SUB: LinkedDir = {
	inner: {
		uuid: "d2000000-0000-0000-0000-000000000000",
		parent: ROOT_UUID,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Sub" } }
	},
	linkedTag: true
}
const LISTING = { dirs: [SUB], files: [] }
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Photos" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: undefined } as unknown as DirPublicLink

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve()
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 800)
	render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
})

afterEach(() => {
	cleanup()
})

describe("DirectoryBrowser — accessibility", () => {
	it("names the breadcrumb and marks the level on screen as the current location", () => {
		fireEvent.doubleClick(screen.getByRole("option", { name: /^Sub/ }))

		const nav = screen.getByRole("navigation", { name: "Location in the shared directory" })
		const current = within(nav).getByText("Sub")

		expect(current.getAttribute("aria-current")).toBe("location")
		expect(within(nav).getByRole("button", { name: "Photos" }).hasAttribute("aria-current")).toBe(false)
	})

	it("names the zip's progress bar", async () => {
		let report: AnonDownloadProgress = () => undefined

		startAnonDirZipDownload.mockImplementationOnce(options => {
			report = options.onProgress

			return new Promise(() => undefined)
		})
		fireEvent.click(screen.getByRole("button", { name: "Download all" }))
		await flush()

		act(() => {
			report(1, 4)
		})

		expect(screen.getByRole("progressbar", { name: "Preparing download…" }).getAttribute("aria-valuenow")).toBe("25")
	})

	it("announces a failed zip", async () => {
		startAnonDirZipDownload.mockResolvedValueOnce({
			status: "error",
			dto: { species: "sdk", kind: "SomethingUnlisted", message: "The connection dropped.", label: "" }
		})
		fireEvent.click(screen.getByRole("button", { name: "Download all" }))
		await flush()

		expect(screen.getByRole("alert").textContent).toBe("The download failed. The connection dropped.")
	})

	it("announces a zip too large to download here", async () => {
		startAnonDirZipDownload.mockResolvedValueOnce({ status: "too-large" })
		fireEvent.click(screen.getByRole("button", { name: "Download all" }))
		await flush()

		expect(screen.getByRole("alert").textContent).toMatch(/^This directory is too large to download here/)
	})
})
