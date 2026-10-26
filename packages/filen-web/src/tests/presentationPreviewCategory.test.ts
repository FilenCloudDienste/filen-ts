import { describe, expect, it, vi } from "vitest"
import type { EntryAccess, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { canPreview, PREVIEW_MAX_BYTES, previewType, unsniffedTemplate } from "@/features/drive/lib/preview.logic"
import { recordFileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"
import { canOpenEntry } from "@/features/archive/lib/entryAccess.logic"
import { storeOf } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: {} }))

// Presentations as the drive's preview sees them: the category, the `.pot` that may be a gettext template, any size
// from the drive (read in ranges), archive entries within the whole-buffer cap, and the info panel's kind.

let next = 0

function fileNamed(name: string, size = 1_024n, mime = "application/octet-stream"): DriveItem {
	const uuid = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` as UuidStr

	return narrowItem({
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime, size, version: 2, key: "", modified: 0n } },
		parent: uuid,
		size,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false
	})
}

const DIRECT: EntryAccess = { type: "direct", packedBytes: 10n }

describe("presentation preview category", () => {
	it.each(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "odp", "otp", "ppt", "pps", "pot", "PPTX"])(
		"%s opens as a presentation",
		ext => {
			expect(previewType(fileNamed(`deck.${ext}`))).toBe("presentation")
		}
	)

	it("reads a .pot as a PowerPoint template until its content says it is text (a gettext template)", () => {
		const messages = fileNamed("messages.pot", 300n)

		expect(previewType(messages)).toBe("presentation")
		expect(unsniffedTemplate(messages)).toBe(true)

		recordFileKindVerdict(messages.data.uuid, "notPresentationBinary")

		expect(previewType(messages)).toBe("text")
		expect(unsniffedTemplate(messages)).toBe(false)
		// A text MIME type says so without a read.
		expect(previewType(fileNamed("de.pot", 300n, "text/x-gettext-translation-template"))).toBe("text")
	})

	it("opens a drive deck of any size (read in ranges, never whole)", () => {
		expect(canPreview(fileNamed("huge.pptx", 2n * 1024n ** 3n))).toBe(true)
	})

	it("opens an archive's deck only within the whole-buffer cap", () => {
		const cap = Number(PREVIEW_MAX_BYTES)

		expect(canOpenEntry(storeOf([{ path: "deck.pptx", access: DIRECT, size: 10 * 1024 ** 2 }]), 0)).toBe(true)
		expect(canOpenEntry(storeOf([{ path: "deck.pptx", access: DIRECT, size: cap + 1 }]), 0)).toBe(false)
	})

	it("names the kind in the info panel", () => {
		expect(previewKindLabelKey("presentation")).toBe("drivePreviewKindPresentation")
	})
})
