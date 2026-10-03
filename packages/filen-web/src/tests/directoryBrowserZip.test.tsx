// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DirPublicInfo, DirPublicLink } from "@filen/sdk-rs"
import type { AnonDownloadOutcome } from "@/features/publicLinks/lib/download"
import "@/lib/i18n"

// A failed or oversized "Download all" says so instead of quietly resetting the button.

const { startAnonDirZipDownload } = vi.hoisted(() => ({
	startAnonDirZipDownload: vi.fn<() => Promise<AnonDownloadOutcome>>()
}))

vi.mock("@/features/publicLinks/lib/download", () => ({ startAnonDirZipDownload }))
vi.mock("@/features/publicLinks/queries/publicLink", () => ({
	useLinkSaveable: () => false,
	usePublicDirListing: () => ({ status: "success", data: LISTING, refetch: vi.fn() }),
	usePublicDirSize: () => ({ data: undefined }),
	usePublicVisitorSignedIn: () => ({ data: false })
}))
vi.mock("@/features/publicLinks/components/fileHero", () => ({ FileHero: () => null }))
vi.mock("@/features/publicLinks/components/saveToDrive", () => ({ SaveToDriveButton: () => null }))

import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"

const ROOT_UUID = "d1000000-0000-0000-0000-000000000000"
const LISTING = {
	dirs: [
		{
			inner: {
				uuid: "d2000000-0000-0000-0000-000000000000",
				parent: ROOT_UUID,
				color: "default",
				timestamp: 0n,
				favorited: false,
				meta: { type: "decoded", data: { name: "Sub" } }
			}
		}
	],
	files: []
}
const INFO = { root: { inner: { uuid: ROOT_UUID, meta: { type: "decoded", data: { name: "Photos" } } } } } as unknown as DirPublicInfo
const LINK = { enableDownload: true, linkKey: "key", password: undefined } as unknown as DirPublicLink
const TOO_LARGE = "This directory is too large to download in this browser. Use a Chromium-based browser or the Filen desktop app."

async function downloadAll(outcome: AnonDownloadOutcome): Promise<void> {
	startAnonDirZipDownload.mockResolvedValueOnce(outcome)
	render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Download all" }))
		await Promise.resolve()
	})
}

beforeEach(() => {
	startAnonDirZipDownload.mockReset()
})

afterEach(() => {
	cleanup()
})

describe("DirectoryBrowser — Download all", () => {
	it("explains a zip that outgrew what this browser can hold", async () => {
		await downloadAll({ status: "too-large" })

		expect(screen.getByText(TOO_LARGE)).toBeDefined()
		expect(screen.getByRole("button", { name: "Download all" })).toBeDefined()
	})

	it("shows a failed zip with the error's own label", async () => {
		await downloadAll({ status: "error", dto: { species: "plain", label: "Connection reset", message: "Connection reset" } })

		expect(screen.getByText("The download failed. Connection reset")).toBeDefined()
	})

	it("says nothing after a cancelled or finished zip", async () => {
		await downloadAll({ status: "cancelled" })

		expect(screen.queryByText(TOO_LARGE)).toBeNull()
		expect(screen.queryByText(/^The download failed/)).toBeNull()
	})

	it.each<[string, AnonDownloadOutcome, RegExp]>([
		["too-large", { status: "too-large" }, /too large to download/],
		[
			"failed",
			{ status: "error", dto: { species: "plain", label: "Connection reset", message: "Connection reset" } },
			/^The download failed/
		]
	])("keeps a %s outcome off a subdirectory opened while the zip ran", async (_name, outcome, notice) => {
		let finish!: (outcome: AnonDownloadOutcome) => void

		startAnonDirZipDownload.mockReturnValueOnce(
			new Promise(resolve => {
				finish = resolve
			})
		)
		render(createElement(DirectoryBrowser, { info: INFO, link: LINK }))
		fireEvent.click(screen.getByRole("button", { name: "Download all" }))
		fireEvent.click(screen.getByRole("listitem"))

		await act(async () => {
			finish(outcome)
			await Promise.resolve()
		})

		expect(screen.getByRole("heading", { name: "Sub" })).toBeDefined()
		expect(screen.queryByText(notice)).toBeNull()
	})
})
