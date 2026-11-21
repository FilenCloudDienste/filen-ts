import { describe, expect, it, vi } from "vitest"
import { SAVE_PORT_CHUNK, SavePortAbortedError, savePortWriter } from "@filen/shared/savePort"
import type { File as SdkFile, SharedFile } from "@filen/sdk-rs"
import {
	canEditImage,
	canEditPdf,
	canSaveCopyBeside,
	editedSaveTimes,
	isEditable,
	isUnresolvableParentError,
	isViewOnlyPdf,
	ownsWritableFile,
	pdfTooLargeToEdit,
	readOnlyOrigin,
	runPreviewSave,
	settledStorageRefusal,
	type PreviewSaveDeps
} from "@/features/drive/lib/previewSave.logic"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { recordFileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import { previewType } from "@/features/drive/lib/preview.logic"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { testUuid } from "@/tests/support/uuid"

const ROOT_UUID = testUuid("root")
const OTHER_PARENT_UUID = testUuid("other-parent")

function mockFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("file"),
		stableUUID: undefined,
		parent: OTHER_PARENT_UUID,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "notes.txt", mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function fileItem(overrides: Partial<SdkFile> = {}): DriveItem {
	const item = narrowItem(mockFile(overrides))
	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}
	return item
}

function dirItem(): DriveItem {
	const item = narrowItem({
		uuid: testUuid("dir"),
		parent: ROOT_UUID,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } }
	})
	if (item.type !== "directory") {
		throw new Error("expected a directory arm")
	}
	return item
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

// Full DecryptedFileMeta shape for a given name — mockFile's own default already carries one for
// "notes.txt"; this covers every other per-test extension the category resolver needs to see.
function decodedMeta(name: string): SdkFile["meta"] {
	return { type: "decoded", data: { name, mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
}

function byMime(name: string, mime: string): SdkFile["meta"] {
	return { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 } }
}

describe("canSaveCopyBeside", () => {
	it("is a readable file in the user's own drive, whatever its format", () => {
		expect(canSaveCopyBeside(fileItem({ meta: decodedMeta("budget.xls") }), "drive")).toBe(true)
	})

	it("is never a file seen outside the drive (trash, shares, links)", () => {
		expect(canSaveCopyBeside(fileItem({ meta: decodedMeta("budget.xls") }), "trash")).toBe(false)
	})

	it("is never an undecryptable file", () => {
		expect(canSaveCopyBeside(fileItem({ meta: { type: "encrypted", data: "cipher" } }), "drive")).toBe(false)
	})
})

describe("isEditable", () => {
	it("is true for a decryptable text file in the drive variant", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("notes.txt") }), "drive")).toBe(true)
	})

	it("is true for a decryptable code file in the drive variant", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("index.ts") }), "drive")).toBe(true)
	})

	it("keeps a message and a mailbox view-only, and edits subtitles, calendars and contacts", () => {
		for (const name of ["mail.eml", "inbox.mbox", "MAIL.EML"]) {
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "drive"), name).toBe(false)
		}

		expect(isEditable(fileItem({ meta: byMime("download", "message/rfc822") }), "drive")).toBe(false)

		for (const name of ["film.srt", "film.vtt", "agenda.ics", "card.vcf"]) {
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "drive"), name).toBe(true)
		}
	})

	it("is false outside the drive variant (e.g. trash)", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("notes.txt") }), "trash")).toBe(false)
	})

	it("is false for a category with no editor (e.g. a PDF)", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("paper.pdf") }), "drive")).toBe(false)
	})

	it("is true for an image the editor writes in place, by its name alone", () => {
		for (const name of ["photo.png", "photo.jpg", "photo.JPEG", "scan.jfif", "art.webp"]) {
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "drive"), name).toBe(true)
		}

		for (const name of ["photo.heic", "anim.gif", "icon.ico", "pic.avif", "old.bmp", "logo.svg"]) {
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "drive"), name).toBe(false)
		}

		expect(isEditable(fileItem({ meta: decodedMeta("photo.png") }), "trash")).toBe(false)
	})

	it("is true for a spreadsheet, but a legacy .xls only opens to be looked at", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("budget.xlsx") }), "drive")).toBe(true)
		expect(isEditable(fileItem({ meta: decodedMeta("list.csv") }), "drive")).toBe(true)
		expect(isEditable(fileItem({ meta: decodedMeta("old.xls") }), "drive")).toBe(false)
	})

	it("is true for tsv and xlsm, and false for a spreadsheet known only by its mime type", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("list.tsv") }), "drive")).toBe(true)
		expect(isEditable(fileItem({ meta: decodedMeta("macros.xlsm") }), "drive")).toBe(true)
		expect(isEditable(fileItem({ meta: byMime("export", "text/csv") }), "drive")).toBe(false)
		expect(
			isEditable(
				fileItem({ meta: byMime("sheet.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") }),
				"drive"
			)
		).toBe(false)
	})

	it("is true for a .docx in the drive, and never outside it", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("report.docx") }), "drive")).toBe(true)
		expect(isEditable(fileItem({ meta: decodedMeta("report.docx") }), "sharedIn")).toBe(false)
		expect(isEditable(fileItem({ meta: decodedMeta("report.docx") }), "trash")).toBe(false)

		// Macro-enabled documents and templates too (shown as Word documents by their type); a document under
		// another name is not.
		const word = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

		for (const name of ["macro.docm", "letter.dotx", "normal.DOTM"]) {
			expect(isEditable(fileItem({ meta: byMime(name, word) }), "drive")).toBe(true)
		}

		expect(isEditable(fileItem({ meta: byMime("report.bin", word) }), "drive")).toBe(false)

		// OpenDocument text documents and templates, saved as ODT; a Word 97–2003 document is not (view-only).
		for (const name of ["notes.odt", "letter.OTT", "story.rtf"]) {
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "drive")).toBe(true)
			expect(isEditable(fileItem({ meta: decodedMeta(name) }), "sharedIn")).toBe(false)
		}

		expect(isEditable(fileItem({ meta: decodedMeta("old.doc") }), "drive")).toBe(false)

		// By their own extensions and types, and only in the user's own drive, whichever listing showed it.
		for (const name of ["macro.docm", "letter.dotx", "normal.dotm"]) {
			for (const variant of ["drive", "sharedOut", "links", "recents", "favorites"] as const) {
				expect(isEditable(fileItem({ meta: decodedMeta(name) }), variant)).toBe(true)
			}

			for (const variant of ["sharedIn", "trash"] as const) {
				expect(isEditable(fileItem({ meta: decodedMeta(name) }), variant)).toBe(false)
			}
		}

		expect(isEditable(fileItem({ meta: byMime("letter", "application/vnd.ms-word.template.macroEnabled.12") }), "drive")).toBe(false)
	})

	it("is true for markdown — edited through the viewer's own source mode", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("readme.md") }), "drive")).toBe(true)
	})

	it("is true for a .markdown file too", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("readme.markdown") }), "drive")).toBe(true)
	})

	it("is false for markdown in the trash or a share received, true from favorites", () => {
		expect(isEditable(fileItem({ meta: decodedMeta("readme.md") }), "trash")).toBe(false)
		expect(isEditable(fileItem({ meta: decodedMeta("readme.md") }), "favorites")).toBe(true)
		expect(isEditable(fileItem({ meta: decodedMeta("readme.md") }), "sharedIn")).toBe(false)
	})

	it("is false for an undecryptable file", () => {
		expect(isEditable(fileItem({ meta: { type: "encrypted", data: "cipher" } }), "drive")).toBe(false)
	})

	it("is false for a directory", () => {
		expect(isEditable(dirItem(), "drive")).toBe(false)
	})
})

describe("readOnlyOrigin", () => {
	const OWNED_VARIANTS = ["drive", "recents", "favorites", "links", "sharedOut"] as const

	function sharedRootFile(): DriveItem {
		const raw: SharedFile = {
			uuid: testUuid("shared-root"),
			size: 1_024n,
			region: "de-1",
			bucket: "filen-1",
			chunks: 1n,
			timestamp: 1_700_000_000_000n,
			meta: decodedMeta("notes.txt"),
			sharingRole: { type: "receiver", email: "a@example.com", id: 1n },
			sharedTag: true,
			canMakeThumbnail: false
		}

		return narrowItem(raw)
	}

	it("writes the user's own file back from every listing of it", () => {
		for (const variant of OWNED_VARIANTS) {
			expect(readOnlyOrigin(fileItem(), variant), variant).toBeNull()
			expect(ownsWritableFile(fileItem(), variant), variant).toBe(true)
		}
	})

	it("keeps a file in the trash or a share received read-only", () => {
		expect(readOnlyOrigin(fileItem(), "trash")).toBe("trash")
		expect(readOnlyOrigin(fileItem(), "sharedIn")).toBe("sharedIn")
	})

	it("keeps someone else's linked file read-only, whichever listing variant its overlay was given", () => {
		const linked = fileItem({ parent: testUuid("file") })

		for (const variant of OWNED_VARIANTS) {
			expect(readOnlyOrigin(linked, variant), variant).toBe("linkedFile")
		}
	})

	it("keeps a file shared out on its own read-only: its listing names no directory to save into", () => {
		expect(readOnlyOrigin(sharedRootFile(), "sharedOut")).toBe("notInDrive")
	})

	// Regression: the user's own public links list opened every file read-only.
	it("edits, annotates and copies a file opened from the links list", () => {
		const text = fileItem()
		const pdf = fileItem({ meta: byMime("form.pdf", "application/pdf") })
		const image = fileItem({ meta: byMime("photo.png", "image/png") })

		expect(isEditable(text, "links")).toBe(true)
		expect(canSaveCopyBeside(text, "links")).toBe(true)
		expect(canEditPdf(pdf, "links", 1_000_000)).toBe(true)
		expect(canEditImage(image, "links")).toBe(true)
	})
})

describe("isUnresolvableParentError", () => {
	it("is true for the exact shape resolveNormalDirParent's worker throw normalizes to", () => {
		expect(
			isUnresolvableParentError({
				species: "plain",
				message: "parent directory not found: missing-uuid",
				label: "parent directory not found: missing-uuid"
			})
		).toBe(true)
	})

	it("is false for a plain error with an unrelated message — a genuinely retryable failure", () => {
		expect(isUnresolvableParentError({ species: "plain", message: "network request failed", label: "network request failed" })).toBe(
			false
		)
	})

	it("is false for an sdk-species error, even one carrying a lookalike message", () => {
		expect(isUnresolvableParentError(sdkDto("parent directory not found: x"))).toBe(false)
	})
})

// All collaborators injected — no module mocks, mirroring createDirectory.test.ts.
function makeHarness() {
	const uploadFileBytes = vi.fn<(parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>>()
	const patchListing = vi.fn<(parentUuid: string | null, updater: (items: DriveItem[]) => DriveItem[]) => void>()
	const checkQuota = vi.fn<NonNullable<PreviewSaveDeps["checkQuota"]>>(() => Promise.resolve({ status: "fits" }))
	const deps: PreviewSaveDeps = { uploadFileBytes, patchListing, checkQuota, rootUuid: ROOT_UUID }
	return { deps, uploadFileBytes, patchListing, checkQuota }
}

describe("canEditImage", () => {
	it("offers the editor for any decodable still in the drive, copy-only formats included", () => {
		for (const name of ["photo.jpg", "photo.png", "photo.heic", "anim.gif", "pic.avif", "old.bmp", "icon.ico", "art.webp"]) {
			expect(canEditImage(fileItem({ meta: byMime(name, "") }), "drive"), name).toBe(true)
		}
	})

	it("never for an SVG, a camera RAW, a non-image, outside the drive or an undecryptable row", () => {
		expect(canEditImage(fileItem({ meta: byMime("logo.svg", "image/svg+xml") }), "drive")).toBe(false)
		expect(canEditImage(fileItem({ meta: byMime("shot.nef", "image/x-nikon-nef") }), "drive")).toBe(false)
		expect(canEditImage(fileItem({ meta: decodedMeta("notes.txt") }), "drive")).toBe(false)
		expect(canEditImage(fileItem({ meta: decodedMeta("photo.jpg") }), "sharedIn")).toBe(false)
		expect(canEditImage(fileItem({ meta: { type: "encrypted", data: "cipher" } }), "drive")).toBe(false)
	})
})

describe("canEditPdf / pdfTooLargeToEdit", () => {
	const LIMIT = 4_096

	function pdf(size: bigint, overrides: Partial<SdkFile> = {}): DriveItem {
		return fileItem({ size, meta: byMime("report.pdf", "application/pdf"), ...overrides })
	}

	it("edits a decryptable PDF in the drive up to the limit, inclusive", () => {
		expect(canEditPdf(pdf(1_024n), "drive", LIMIT)).toBe(true)
		expect(canEditPdf(pdf(4_096n), "drive", LIMIT)).toBe(true)
		expect(pdfTooLargeToEdit(pdf(4_096n), "drive", LIMIT)).toBe(false)
	})

	it("only views a PDF-compatible Illustrator file", () => {
		const ai = fileItem({ size: 1_024n, meta: byMime("logo.ai", "application/illustrator") })

		recordFileKindVerdict(ai.data.uuid, "pdfCompatible", { memoryOnly: true })

		expect(previewType(ai)).toBe("pdf")
		expect(canEditPdf(ai, "drive", LIMIT)).toBe(false)
		expect(pdfTooLargeToEdit(ai, "drive", LIMIT)).toBe(false)
		// No tools at all, not tools shown disabled.
		expect(isViewOnlyPdf(ai)).toBe(true)
		expect(isViewOnlyPdf(pdf(1_024n))).toBe(false)
	})

	it("is too large only when everything but the size passes", () => {
		expect(canEditPdf(pdf(4_097n), "drive", LIMIT)).toBe(false)
		expect(pdfTooLargeToEdit(pdf(4_097n), "drive", LIMIT)).toBe(true)
		expect(pdfTooLargeToEdit(pdf(4_097n), "sharedIn", LIMIT)).toBe(false)
		expect(pdfTooLargeToEdit(fileItem({ size: 4_097n, meta: decodedMeta("notes.txt") }), "drive", LIMIT)).toBe(false)
	})

	it("never in the trash or a share received, for a non-PDF, a directory or an undecryptable row", () => {
		for (const variant of ["sharedOut", "recents", "favorites", "links"] as const) {
			expect(canEditPdf(pdf(1_024n), variant, LIMIT), variant).toBe(true)
		}
		for (const variant of ["sharedIn", "trash"] as const) {
			expect(canEditPdf(pdf(1_024n), variant, LIMIT), variant).toBe(false)
		}
		expect(canEditPdf(fileItem({ meta: decodedMeta("notes.txt") }), "drive", LIMIT)).toBe(false)
		expect(canEditPdf(dirItem(), "drive", LIMIT)).toBe(false)
		expect(canEditPdf(pdf(1_024n, { meta: { type: "encrypted", data: "cipher" } }), "drive", LIMIT)).toBe(false)
		expect(pdfTooLargeToEdit(pdf(4_097n, { meta: { type: "encrypted", data: "cipher" } }), "drive", LIMIT)).toBe(false)
	})
})

describe("editedSaveTimes", () => {
	it("keeps the original's own creation time and stamps modified now", () => {
		const item = fileItem({
			meta: {
				type: "decoded",
				data: {
					name: "a.jpg",
					mime: "image/jpeg",
					created: 1_600_000_000_000n,
					modified: 1_650_000_000_000n,
					size: 1n,
					key: "k",
					version: 2
				}
			}
		})

		expect(editedSaveTimes(item, 1_800_000_000_000.7)).toEqual({ created: 1_600_000_000_000n, modified: 1_800_000_000_000n })
	})

	it("keeps an edited video's creation time the same way", () => {
		const item = fileItem({
			meta: {
				type: "decoded",
				data: {
					name: "clip.mp4",
					mime: "video/mp4",
					created: 1_500_000_000_000n,
					modified: 1_550_000_000_000n,
					size: 1n,
					key: "k",
					version: 2
				}
			}
		})

		expect(editedSaveTimes(item, 1_800_000_000_000)).toEqual({ created: 1_500_000_000_000n, modified: 1_800_000_000_000n })
	})

	it("falls back to the capture time the Photos timeline sorts by when the file has none", () => {
		const item = fileItem({ timestamp: 1_700_000_000_000n, meta: byMime("a.jpg", "image/jpeg") })
		const { created } = editedSaveTimes(item, 1_800_000_000_000)

		expect(created).toBeLessThanOrEqual(1_700_000_000_000n)
		expect(created).toBeGreaterThan(0n)
	})
})

describe("runPreviewSave (injected deps, no worker or query client)", () => {
	it("encodes the content, uploads it, and returns the narrowed new item on success", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))
		const item = fileItem({ uuid: testUuid("old"), parent: OTHER_PARENT_UUID })

		const outcome = await runPreviewSave(h.deps, { item, content: "hello world" })

		expect(outcome.status).toBe("success")
		if (outcome.status !== "success") {
			throw new Error("expected success")
		}
		expect(outcome.item.data.uuid).toBe(testUuid("new"))
		expect(h.uploadFileBytes).toHaveBeenCalledTimes(1)
		const [parentArg, dataArg, nameArg, mimeArg] = h.uploadFileBytes.mock.calls[0] ?? []
		expect(parentArg).toBe(OTHER_PARENT_UUID)
		expect(nameArg).toBe("notes.txt")
		expect(mimeArg).toBe("text/plain")
		expect(new TextDecoder().decode(dataArg)).toBe("hello world")
	})

	it("collapses the root uuid to null before uploading and patching", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new"), parent: ROOT_UUID }))
		const item = fileItem({ uuid: testUuid("old"), parent: ROOT_UUID })

		await runPreviewSave(h.deps, { item, content: "x" })

		expect(h.uploadFileBytes).toHaveBeenCalledWith(null, expect.any(Uint8Array), "notes.txt", "text/plain", {})
		expect(h.patchListing).toHaveBeenCalledWith(null, expect.any(Function), { writeNow: true })
	})

	it("patches the item's own (non-root) parent listing, dropping the old uuid, upserting the new one", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new"), parent: OTHER_PARENT_UUID }))
		const item = fileItem({ uuid: testUuid("old"), parent: OTHER_PARENT_UUID })

		await runPreviewSave(h.deps, { item, content: "x" })

		expect(h.patchListing).toHaveBeenCalledTimes(1)
		expect(h.patchListing).toHaveBeenCalledWith(OTHER_PARENT_UUID, expect.any(Function), { writeNow: true })
		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([item])
		expect(patched.map(i => i.data.uuid)).toEqual([testUuid("new")])
	})

	it("drops the old uuid even when the stale row is undecryptable (no name for the intrinsic dedup to match on)", async () => {
		const h = makeHarness()
		const undecryptable = (() => {
			const raw = narrowItem({ ...mockFile({ uuid: testUuid("old") }), meta: { type: "encrypted", data: "cipher" } })
			if (raw.type !== "file") {
				throw new Error("expected a file arm")
			}
			return raw
		})()
		h.uploadFileBytes.mockResolvedValue(mockFile({ uuid: testUuid("new") }))

		await runPreviewSave(h.deps, { item: undecryptable, content: "x" })

		const updater = h.patchListing.mock.calls[0]?.[1]
		if (!updater) {
			throw new Error("expected patchListing to receive an updater")
		}
		const patched = updater([undecryptable])
		expect(patched).toHaveLength(1)
		expect(patched[0]?.data.uuid).toBe(testUuid("new"))
	})

	it("returns an error outcome without patching when uploadFileBytes rejects", async () => {
		const h = makeHarness()
		const dto = sdkDto("FileNotFound")
		h.uploadFileBytes.mockRejectedValue(dto)
		const item = fileItem()

		const outcome = await runPreviewSave(h.deps, { item, content: "x" })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.patchListing).not.toHaveBeenCalled()
	})

	it("streams a Blob through uploadFileBlob with the given times, the Exif override off, and the mime given", async () => {
		const uploadFileBlob = vi.fn<NonNullable<PreviewSaveDeps["uploadFileBlob"]>>(() =>
			Promise.resolve(mockFile({ uuid: testUuid("copy") }))
		)
		const patchListing = vi.fn<PreviewSaveDeps["patchListing"]>()
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" })
		const item = fileItem({ uuid: testUuid("old"), meta: byMime("photo.heic", "image/heic") })

		const outcome = await runPreviewSave(
			{ uploadFileBytes: vi.fn(), uploadFileBlob, patchListing, rootUuid: ROOT_UUID },
			{ item, content: { blob }, asNewFile: "photo (edited).jpg", mime: "", times: { created: 5n, modified: 9n } }
		)

		expect(outcome.status).toBe("success")
		expect(uploadFileBlob).toHaveBeenCalledWith(OTHER_PARENT_UUID, blob, "photo (edited).jpg", "", {
			created: 5n,
			modified: 9n,
			noExifOverride: true
		})

		// A copy joins the listing beside the original.
		const updater = patchListing.mock.calls[0]?.[1]
		expect(updater?.([item]).map(row => row.data.uuid)).toEqual([testUuid("old"), testUuid("copy")])
	})

	it("hands an Orientation-only save to the rewrite with the file itself", async () => {
		const rewriteOrientation = vi.fn<NonNullable<PreviewSaveDeps["rewriteOrientation"]>>(() =>
			Promise.resolve(mockFile({ uuid: testUuid("turned") }))
		)
		const item = fileItem({ uuid: testUuid("old"), meta: byMime("photo.jpg", "image/jpeg") })

		const outcome = await runPreviewSave(
			{ uploadFileBytes: vi.fn(), rewriteOrientation, patchListing: vi.fn(), rootUuid: ROOT_UUID },
			{ item, content: { orientation: 6 }, times: { created: 1n, modified: 2n }, mime: "image/jpeg" }
		)

		expect(outcome).toMatchObject({ status: "success", item: { data: { uuid: testUuid("turned") } } })
		expect(rewriteOrientation).toHaveBeenCalledWith(
			expect.objectContaining({ uuid: testUuid("old") }),
			6,
			OTHER_PARENT_UUID,
			"photo.jpg",
			"image/jpeg",
			{ created: 1n, modified: 2n, noExifOverride: true }
		)
	})

	it("fails a Blob save without a Blob upload", async () => {
		const outcome = await runPreviewSave(
			{ uploadFileBytes: vi.fn(), patchListing: vi.fn(), rootUuid: ROOT_UUID },
			{ item: fileItem(), content: { blob: new Blob([]) } }
		)

		expect(outcome.status).toBe("error")
	})

	it("surfaces a parent-not-found worker throw (unresolvable parent) as a plain error outcome", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockRejectedValue(new Error("parent directory not found: missing-uuid"))
		const item = fileItem()

		const outcome = await runPreviewSave(h.deps, { item, content: "x" })

		expect(outcome).toEqual({
			status: "error",
			dto: {
				species: "plain",
				message: "parent directory not found: missing-uuid",
				label: "parent directory not found: missing-uuid"
			}
		})
		expect(h.patchListing).not.toHaveBeenCalled()
	})
})

describe("runPreviewSave storage pre-flight", () => {
	const exceeds = { status: "exceeds", neededBytes: 5n, freeBytes: 1n } as const

	it("checks the encoded size of a text save and refuses it before any upload, tagged as the server's refusal", async () => {
		const h = makeHarness()
		h.checkQuota.mockResolvedValue(exceeds)

		const outcome = await runPreviewSave(h.deps, { item: fileItem(), content: "héllo" })

		expect(h.checkQuota).toHaveBeenCalledExactlyOnceWith(6n)
		expect(h.uploadFileBytes).not.toHaveBeenCalled()
		expect(h.patchListing).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "error", dto: { species: "plain", kind: "MaxStorageReached" } })
	})

	it("uploads once the check passes", async () => {
		const h = makeHarness()
		h.uploadFileBytes.mockResolvedValue(mockFile())

		await runPreviewSave(h.deps, { item: fileItem(), content: new Uint8Array(3) })

		expect(h.checkQuota).toHaveBeenCalledExactlyOnceWith(3n)
		expect(h.uploadFileBytes).toHaveBeenCalledOnce()
	})

	it("sizes a Blob by its size and an Orientation rewrite by the file's own", async () => {
		const checkQuota = vi.fn<NonNullable<PreviewSaveDeps["checkQuota"]>>(() => Promise.resolve(exceeds))
		const uploadFileBlob = vi.fn<NonNullable<PreviewSaveDeps["uploadFileBlob"]>>()
		const rewriteOrientation = vi.fn<NonNullable<PreviewSaveDeps["rewriteOrientation"]>>()
		const deps: PreviewSaveDeps = {
			uploadFileBytes: vi.fn(),
			uploadFileBlob,
			rewriteOrientation,
			patchListing: vi.fn(),
			checkQuota,
			rootUuid: ROOT_UUID
		}
		const item = fileItem({ size: 4_096n, meta: byMime("photo.jpg", "image/jpeg") })

		await runPreviewSave(deps, { item, content: { blob: new Blob([new Uint8Array(7)]) } })
		await runPreviewSave(deps, { item, content: { orientation: 6 } })

		expect(checkQuota.mock.calls).toEqual([[7n], [4_096n]])
		expect(uploadFileBlob).not.toHaveBeenCalled()
		expect(rewriteOrientation).not.toHaveBeenCalled()
	})

	// The engine's writer on the other end of the save port, its worker serving one request at a time: a request queued
	// behind the write only runs once the write settles.
	function blockedWriter(port: MessagePort): { readonly write: Promise<void>; readonly queued: Promise<string> } {
		const writer = savePortWriter(port)
		const write = writer.write(new Uint8Array(SAVE_PORT_CHUNK))
		const queued = write.then(
			() => "saveEnd",
			() => "saveEnd"
		)

		return { write, queued }
	}

	it("aborts a port save refused by the quota pre-flight, so the writer on its other end never blocks", async () => {
		const h = makeHarness()
		const uploadFileFromPort = vi.fn<NonNullable<PreviewSaveDeps["uploadFileFromPort"]>>()
		const channel = new MessageChannel()
		const engine = blockedWriter(channel.port1)
		h.checkQuota.mockResolvedValue(exceeds)

		const outcome = await runPreviewSave(
			{ ...h.deps, uploadFileFromPort },
			{ item: fileItem(), content: { port: channel.port2, size: 9 } }
		)

		expect(h.checkQuota).toHaveBeenCalledExactlyOnceWith(9n)
		expect(uploadFileFromPort).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "error", dto: { kind: "MaxStorageReached" } })
		await expect(engine.write).rejects.toEqual(new SavePortAbortedError("upload"))
		await expect(engine.queued).resolves.toBe("saveEnd")
	})

	it("aborts a port save where no port upload is wired", async () => {
		const h = makeHarness()
		const channel = new MessageChannel()
		const engine = blockedWriter(channel.port1)

		const outcome = await runPreviewSave(h.deps, { item: fileItem(), content: { port: channel.port2, size: 9 } })

		expect(outcome.status).toBe("error")
		await expect(engine.write).rejects.toEqual(new SavePortAbortedError("upload"))
		await expect(engine.queued).resolves.toBe("saveEnd")
	})

	it("hands a refused port save the quota refusal its upload already answered, never waiting for one still running", async () => {
		const h = makeHarness()
		const channel = new MessageChannel()
		const engine = blockedWriter(channel.port1)
		h.checkQuota.mockResolvedValue(exceeds)

		const upload = runPreviewSave(
			{ ...h.deps, uploadFileFromPort: vi.fn() },
			{ item: fileItem(), content: { port: channel.port2, size: 9 } }
		)

		// The writer's refusal (the session's save result) only follows the abort the refused upload sent.
		await expect(engine.write).rejects.toEqual(new SavePortAbortedError("upload"))
		await expect(settledStorageRefusal(upload)).resolves.toMatchObject({ kind: "MaxStorageReached" })

		const pending = new Promise<never>(() => undefined)
		const otherError = Promise.resolve({ status: "error", dto: sdkDto("Unauthenticated") } as const)

		await expect(settledStorageRefusal(pending)).resolves.toBeNull()
		await expect(settledStorageRefusal(otherError)).resolves.toBeNull()
		await expect(settledStorageRefusal(Promise.reject(new Error("upload threw")))).resolves.toBeNull()
	})

	it("leaves a port save of unknown size to the server", async () => {
		const h = makeHarness()
		const uploadFileFromPort = vi.fn<NonNullable<PreviewSaveDeps["uploadFileFromPort"]>>(() => Promise.resolve(mockFile()))
		const channel = new MessageChannel()

		await runPreviewSave({ ...h.deps, uploadFileFromPort }, { item: fileItem(), content: { port: channel.port2 } })

		expect(h.checkQuota).not.toHaveBeenCalled()
		expect(uploadFileFromPort).toHaveBeenCalledOnce()
		channel.port1.close()
	})
})
