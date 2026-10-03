// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/lib/i18n"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"

const { startExtractWithCard, archiveNameInfo, itemNameError } = vi.hoisted(() => ({
	startExtractWithCard: vi.fn<(request: unknown, password: string | undefined) => string>(),
	archiveNameInfo: vi.fn<(name: string) => Promise<ArchiveNameInfo>>(),
	// The SDK's own name rules, as far as these tests go.
	itemNameError: vi.fn((name: string) => Promise.resolve(name.includes(":") ? "ForbiddenChar" : null))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startExtractWithCard }))
vi.mock("@/features/drive/lib/archiveHelpers", () => ({
	archiveNameInfo,
	cachedArchiveNameInfo: () => undefined,
	itemNameError,
	cachedItemNameError: () => undefined
}))
// Stands in for the picker's new-directory prompt: a form portalled out of the dialog's DOM, still inside
// its React tree.
vi.mock("@/features/drive/components/destinationField", async () => {
	const { createElement } = await import("react")
	const { createPortal } = await import("react-dom")

	return {
		DestinationField: () =>
			createPortal(
				createElement("form", { "aria-label": "New directory" }, createElement("button", { type: "submit" }, "Create")),
				document.body
			)
	}
})

import { ExtractDialog } from "@/features/drive/components/extractDialog"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { ARCHIVE_ITEM, extractJob } from "@/tests/support/archiveJobFixtures"

const ZIP: ArchiveNameInfo = { format: { type: "zip" }, defaultName: "photos" }
const onClose = vi.fn()

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
}

async function show(options: { variant?: DriveVariant; knownEncrypted?: boolean; info?: ArchiveNameInfo } = {}): Promise<HTMLElement> {
	archiveNameInfo.mockResolvedValue(options.info ?? ZIP)
	render(
		<ExtractDialog
			item={ARCHIVE_ITEM}
			variant={options.variant ?? "drive"}
			knownEncrypted={options.knownEncrypted}
			onClose={onClose}
		/>,
		{ wrapper }
	)

	const dialog = await screen.findByRole("dialog")

	await screen.findByText("Skip macOS metadata")

	return dialog
}

function submit(): void {
	fireEvent.click(screen.getByRole("button", { name: "Extract" }))
}

function lastRequest(): Record<string, unknown> {
	return startExtractWithCard.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(() => {
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
	startExtractWithCard.mockReturnValue("job")
})

afterEach(() => {
	cleanup()
	useDriveStore.getState().clearSelectedItems()
})

describe("ExtractDialog", () => {
	it("extracts into a new directory named after the archive, without a password, and closes", async () => {
		await show()

		expect(screen.getByLabelText<HTMLInputElement>("Directory name").value).toBe("photos")
		expect(screen.queryByLabelText("Password")).toBeNull()

		submit()

		expect(startExtractWithCard).toHaveBeenCalledTimes(1)
		expect(startExtractWithCard.mock.calls[0]?.[1]).toBeUndefined()
		expect(lastRequest()).toMatchObject({ root: { type: "newFolder" }, rowName: "photos", skipMacMetadata: true, dispose: null })
		expect(onClose).toHaveBeenCalled()
	})

	it("extracts into a typed directory name, or straight into the destination", async () => {
		await show()

		fireEvent.change(screen.getByLabelText("Directory name"), { target: { value: "Holiday" } })
		submit()

		// The SDK is asked about the typed name first.
		await waitFor(() => {
			expect(lastRequest()).toMatchObject({ root: { type: "newFolder", name: "Holiday" }, rowName: "Holiday" })
		})
		expect(itemNameError).toHaveBeenCalledWith("Holiday")

		cleanup()
		await show()
		fireEvent.click(screen.getByRole("radio", { name: /^Directly into/ }))
		submit()

		expect(lastRequest()).toMatchObject({ root: { type: "destination" }, glyph: "items" })
	})

	it("refuses an empty directory name at once", async () => {
		await show()

		fireEvent.change(screen.getByLabelText("Directory name"), { target: { value: "" } })

		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(false)
		expect(screen.getByText("Enter a name")).toBeTruthy()

		submit()

		expect(startExtractWithCard).not.toHaveBeenCalled()
	})

	it("says why the SDK refuses a typed directory name, and starts nothing", async () => {
		await show()

		fireEvent.change(screen.getByLabelText("Directory name"), { target: { value: "a:b" } })

		expect(await screen.findByText(/^Names can't contain/)).toBeTruthy()

		submit()
		await waitFor(() => {
			expect(itemNameError).toHaveBeenCalledWith("a:b")
		})

		expect(startExtractWithCard).not.toHaveBeenCalled()
	})

	it("labels the root choice", async () => {
		await show()

		expect(screen.getByRole("radiogroup", { name: "Put the contents" })).toBeTruthy()
	})

	it("keeps the root choice for a name read as a single compressed file, which the bytes decide", async () => {
		const dialog = await show({ info: { format: { type: "single", codec: "gzip" }, defaultName: "photo.jpg" } })

		expect(screen.getByRole("radio", { name: "Into a new directory" })).toBeTruthy()
		expect(dialog.textContent).toContain(
			"If this is a single compressed file, it extracts as “photo.jpg” straight into the destination."
		)

		submit()

		// The SDK ignores the new directory for a real one.
		expect(lastRequest()).toMatchObject({ root: { type: "newFolder" }, glyph: "file", rowName: "photo.jpg" })
	})

	it("refuses a password longer than archives allow", async () => {
		await show({ knownEncrypted: true })

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a".repeat(1025) } })

		expect(screen.getByText("A password can have at most 1024 characters")).toBeTruthy()

		submit()

		expect(startExtractWithCard).not.toHaveBeenCalled()
	})

	it("opens the password section for an archive known to be encrypted, sending the password typed", async () => {
		await show({ knownEncrypted: true })

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } })
		submit()

		expect(startExtractWithCard.mock.calls[0]?.[1]).toBe("s3cret")
	})

	it("opens the password section when an earlier extract of this archive stopped for its password", async () => {
		useDriveJobsStore.setState({ jobs: { old: extractJob({ outcome: { status: "wrongPassword" } }, "old") } })
		await show()

		expect(screen.getByLabelText("Password")).toBeTruthy()
	})

	it("sends no password when its field is left empty", async () => {
		await show({ knownEncrypted: true })
		submit()

		expect(startExtractWithCard.mock.calls[0]?.[1]).toBeUndefined()
	})

	it("offers what to do with the archive only for an own archive", async () => {
		await show()

		expect(screen.getByText("Afterwards")).toBeTruthy()

		cleanup()
		await show({ variant: "sharedIn" })

		expect(screen.queryByText("Afterwards")).toBeNull()
	})

	it("asks before deleting the archive for good, mentioning the macOS metadata left out", async () => {
		await show()

		fireEvent.click(screen.getByRole("radio", { name: "Delete the archive permanently" }))
		submit()

		const confirm = await screen.findByRole("alertdialog")

		expect(confirm.textContent).toContain("Once everything is extracted and checked, the archive is deleted permanently.")
		expect(confirm.textContent).toContain("macOS metadata left out goes with it.")
		expect(startExtractWithCard).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }))

		expect(lastRequest()).toMatchObject({ dispose: "deletePermanently" })
	})

	it("ignores a submit bubbling up from the destination picker's own form", async () => {
		await show()

		fireEvent.submit(screen.getByRole("form", { name: "New directory" }))

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("labels what happens afterwards by the archive", async () => {
		await show()

		expect(screen.getByRole("radio", { name: "Keep the archive" })).toBeTruthy()
		expect(screen.queryByRole("radio", { name: "Keep the originals" })).toBeNull()
		expect(screen.getByText("Once everything is extracted and checked. It will not be in the trash.")).toBeTruthy()
	})

	it("moves the archive to the trash without asking", async () => {
		await show()

		fireEvent.click(screen.getByRole("radio", { name: "Move the archive to the trash" }))
		submit()

		await waitFor(() => {
			expect(lastRequest()).toMatchObject({ dispose: "trash" })
		})
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("drops a removed archive from the selection, and keeps a kept one", async () => {
		useDriveStore.getState().setSelectedItems([ARCHIVE_ITEM])
		await show()
		submit()

		expect(useDriveStore.getState().selectedItems).toEqual([ARCHIVE_ITEM])

		cleanup()
		await show()
		fireEvent.click(screen.getByRole("radio", { name: "Move the archive to the trash" }))
		submit()

		expect(useDriveStore.getState().selectedItems).toEqual([])
	})
})
