// Copy content may wait on a network read of the note: the clipboard write must start inside the click, before
// that read settles, or Safari refuses it once the click's activation has ended.
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"

const { toastSuccess, toastError, resolveNoteContent } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	resolveNoteContent: vi.fn<() => Promise<string>>()
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: (e: unknown) => (e instanceof Error ? e.message : "unknown") }))
vi.mock("@/features/notes/lib/actions", () => ({
	togglePinned: vi.fn(),
	toggleFavorited: vi.fn(),
	duplicateNote: vi.fn(),
	archiveNote: vi.fn(),
	restoreNote: vi.fn(),
	trashNote: vi.fn(),
	resolveNoteContent
}))
vi.mock("@/features/notes/lib/export", () => ({ exportNote: vi.fn() }))
vi.mock("@/lib/activity/activity", () => ({ runOutcomeActivity: vi.fn() }))

const { runNoteDirectAction } = await import("@/features/notes/lib/noteDirectAction")
const { mockNote } = await import("@/tests/fixtures/notes")

const t = ((key: string) => key) as unknown as TFunction<["notes", "common"]>

// Keeps the text promise a ClipboardItem was made with, as `item`, for a write stub to await.
class ClipboardItemStub {
	item: Promise<Blob>

	constructor(data: Record<string, Promise<Blob>>) {
		this.item = data["text/plain"] ?? Promise.reject(new Error("no text/plain"))
	}
}

// A clipboard that, like a browser, replaces a failed item promise's error with its own.
function stubClipboard() {
	const write = vi.fn(async (items: { item: Promise<Blob> }[]) => {
		try {
			await items[0]?.item
		} catch {
			throw new Error("NotAllowedError")
		}
	})
	const writeText = vi.fn(() => Promise.resolve())

	vi.stubGlobal("ClipboardItem", ClipboardItemStub)
	vi.stubGlobal("navigator", { clipboard: { write, writeText } })

	return { write, writeText }
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe("runNoteDirectAction — copyContent", () => {
	it("starts the clipboard write before the content read settles, then says it copied", async () => {
		const { write, writeText } = stubClipboard()
		let resolveContent: (content: string) => void = () => undefined

		resolveNoteContent.mockReturnValue(
			new Promise<string>(resolve => {
				resolveContent = resolve
			})
		)

		const done = runNoteDirectAction(mockNote(), "copyContent", t, undefined)

		expect(write).toHaveBeenCalledTimes(1)
		expect(write.mock.calls[0]?.[0][0]).toBeInstanceOf(ClipboardItemStub)

		resolveContent("note body")
		await done

		const blob = await write.mock.calls[0]?.[0][0]?.item

		expect(await blob?.text()).toBe("note body")
		expect(writeText).not.toHaveBeenCalled()
		expect(toastSuccess).toHaveBeenCalledWith("noteCopyContentToast")
		expect(toastError).not.toHaveBeenCalled()
	})

	it("says the read's own error when the content can't be read, never a success", async () => {
		stubClipboard()
		resolveNoteContent.mockReturnValue(Promise.reject(new Error("This note's content couldn't be decrypted.")))

		await runNoteDirectAction(mockNote(), "copyContent", t, undefined)

		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("This note's content couldn't be decrypted.")
	})
})
