// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { ErrorWithDTO } from "@/lib/sdk/errors"
import type { IworkPreviewEntry, OpenIworkPreviewOptions } from "@/features/iwork/lib/iworkPreview"
import "@/lib/i18n"

// An iWork document shows the rendering it carries under a note that it is only a preview; one carrying none, or no
// package at all, shows its card; a failed read offers to try again.

const handle = vi.hoisted(() => ({ release: vi.fn() }))
const opener = vi.hoisted(() => ({
	openIworkPreview: vi.fn<(_handle: unknown, _options: OpenIworkPreviewOptions) => Promise<IworkPreviewEntry | null>>()
}))

vi.mock("@/features/archive/lib/archiveHandle", () => ({ acquireArchiveHandle: () => ({ id: "h", ...handle }) }))
vi.mock("@/features/iwork/lib/iworkPreview", () => opener)
vi.mock("@/features/preview/components/readOnlyPreviewBody", () => ({
	ReadOnlyPreviewBody: ({ category, item }: { category: string; item: { data: { uuid: string } } }) =>
		createElement("p", null, `body:${category}:${item.data.uuid}`)
}))

const { IworkPreview } = await import("@/features/iwork/components/iworkPreview")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")

const UUID = "d1000000-0000-0000-0000-000000000000"

function entry(kind: "pdf" | "image", release = vi.fn()): IworkPreviewEntry {
	const origin: ByteOrigin = {
		kind: "entry",
		reader: "r",
		entry: { archive: UUID, index: 3 },
		size: 2048,
		access: "whole",
		anon: false,
		cacheKey: `${UUID}#3`
	}

	return { lease: { origin, release }, kind, index: 3, name: kind === "pdf" ? "Preview.pdf" : "preview.jpg", size: 2048, modified: NaN }
}

function renderPreview(name: string) {
	const item = linkedFileItem(name, { size: 3_000_000n, uuid: UUID })

	return render(createElement(IworkPreview, { item, alt: name }))
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("IworkPreview", () => {
	it("shows a first-page image under the note naming the document's app, and lets both go on unmount", async () => {
		const release = vi.fn()

		opener.openIworkPreview.mockResolvedValue(entry("image", release))

		const view = renderPreview("report.pages")

		await waitFor(() => {
			expect(screen.getByText(`body:image:${UUID}#3`)).toBeTruthy()
		})
		expect(screen.getByText("Preview image of the first page. Open in Pages for the full document.")).toBeTruthy()

		view.unmount()
		expect(release).toHaveBeenCalledOnce()
		expect(handle.release).toHaveBeenCalledOnce()
	})

	// The lease arrives after the view is gone: it must not hold the archive and its entry reader until sign-out.
	it("lets a lease that arrives after unmount go", async () => {
		const release = vi.fn()
		let resolve: (opened: IworkPreviewEntry) => void = () => undefined

		opener.openIworkPreview.mockImplementation(
			() =>
				new Promise(done => {
					resolve = done
				})
		)

		const view = renderPreview("report.pages")

		view.unmount()
		resolve(entry("image", release))

		await waitFor(() => {
			expect(release).toHaveBeenCalledOnce()
		})
		expect(handle.release).toHaveBeenCalledOnce()
	})

	it("shows an older document's PDF copy as a PDF", async () => {
		opener.openIworkPreview.mockResolvedValue(entry("pdf"))
		renderPreview("deck.key")

		await waitFor(() => {
			expect(screen.getByText(`body:pdf:${UUID}#3`)).toBeTruthy()
		})
		expect(screen.getByText("Preview copy saved in the document. Open in Keynote for the full document.")).toBeTruthy()
	})

	it.each([
		["carries no rendering", () => Promise.resolve(null)],
		["is no package", () => Promise.reject(new ErrorWithDTO({ species: "sdk", kind: "ArchiveUnsupported", label: "x", message: "x" }))]
	])("shows the card when the document %s", async (_case, outcome) => {
		opener.openIworkPreview.mockImplementation(outcome)
		renderPreview("budget.numbers")

		await waitFor(() => {
			expect(screen.getByText("No preview inside this file.")).toBeTruthy()
		})
		expect(screen.queryByText(/body:/)).toBeNull()
	})

	it("offers to try again after a failed read, and reads again", async () => {
		opener.openIworkPreview.mockRejectedValueOnce({ species: "plain", label: "Network down", message: "Network down" })
		opener.openIworkPreview.mockResolvedValueOnce(entry("image"))
		renderPreview("report.pages")

		const retry = await screen.findByRole("button", { name: "Try again" })

		fireEvent.click(retry)

		await waitFor(() => {
			expect(screen.getByText(`body:image:${UUID}#3`)).toBeTruthy()
		})
		expect(opener.openIworkPreview).toHaveBeenCalledTimes(2)
	})

	it("waits for another archive job, and stopping offers to try again", async () => {
		opener.openIworkPreview.mockImplementation((_handle, options) => {
			options.onWaiting(true)

			return new Promise(() => undefined)
		})
		renderPreview("report.pages")

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))

		expect(screen.getByText("Its contents weren't listed.")).toBeTruthy()
		expect(handle.release).toHaveBeenCalledOnce()
	})
})
