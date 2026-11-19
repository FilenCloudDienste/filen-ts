import { describe, expect, it, vi } from "vitest"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PdfSaveActionDeps, PdfSaveRequest } from "@/features/pdf/session/pdfEditActions"

// A Save a tool asked for (a redaction's save in place) that the remote-change or the form's question turns into
// "Save as copy" starts no detached copy: the request settles once, failed, and the tool decides what follows. A Save
// the user asked for still becomes the copy.

const savePdfCopy = vi.fn(() => Promise.resolve(null))
const savePdfVersion = vi.fn()

vi.mock("@/features/pdf/save/pdfSave", () => ({ savePdfCopy, savePdfVersion, signPdfVersion: vi.fn() }))
vi.mock("@/features/pdf/save/remoteChange", () => ({ checkRemoteHead: () => Promise.resolve({ kind: "changed" }) }))
vi.mock("@/features/preview/lib/editedCopy", () => ({ writeEditedCopy: vi.fn() }))
vi.mock("@/features/preview/lib/ownSaves", () => ({ recordOwnSave: () => undefined }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const { pdfEditActions } = await import("@/features/pdf/session/pdfEditActions")

const ITEM = { type: "file", data: { uuid: "u" } } as unknown as DriveItem

function deps(request: PdfSaveRequest | null, options: { remote?: "copy" | "cancel"; form?: "copy" | "cancel" } = {}) {
	const commitDrafts = vi.fn(() => Promise.resolve())
	const current = {
		commitDrafts,
		askRemote: () => Promise.resolve(options.remote ?? "copy"),
		copySuffix: () => "edited",
		onCopied: vi.fn(),
		onCopyFailed: vi.fn(),
		takeRequest: () => request,
		...(options.form === undefined ? {} : { beforeSave: () => Promise.resolve(options.form) })
	} as unknown as PdfSaveActionDeps

	return { current, commitDrafts }
}

async function settleTurns(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("a tool's save turned into a copy", () => {
	it.each([
		["the remote-change question", { remote: "copy" as const }],
		["the form's question", { form: "copy" as const }]
	])("starts no copy when %s answers Save as copy, and settles the request once", async (_name, options) => {
		savePdfCopy.mockClear()

		const settle = vi.fn()
		const { current, commitDrafts } = deps({ job: null, settle }, options)

		await expect(pdfEditActions(() => current, ITEM).saveVersion()).rejects.toThrow()
		await settleTurns()
		expect(savePdfCopy).not.toHaveBeenCalled()
		expect(commitDrafts).not.toHaveBeenCalled()
		expect(settle).toHaveBeenCalledTimes(1)
		expect(settle.mock.calls[0]?.[0]).toMatchObject({ status: "failed" })
	})

	it("still saves a copy when the user's own Save is answered Save as copy", async () => {
		savePdfCopy.mockClear()

		const { current } = deps(null, { remote: "copy" })

		await expect(pdfEditActions(() => current, ITEM).saveVersion()).rejects.toThrow()
		await vi.waitFor(() => {
			expect(savePdfCopy).toHaveBeenCalledTimes(1)
		})
	})
})
