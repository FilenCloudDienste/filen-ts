import { describe, expect, it } from "vitest"
import {
	clipboardEntries,
	clipboardFiles,
	clipboardNameTime,
	isNativePasteKey,
	isUnnamedClipboardFile,
	namePastedFiles
} from "@/features/drive/lib/clipboardUpload.logic"

interface FakeItem {
	kind: string
	getAsFile: () => File | null
	webkitGetAsEntry?: () => FileSystemEntry | null
}

function data(files: File[], items: FakeItem[] = []): DataTransfer {
	return { files, items } as unknown as DataTransfer
}

const NOW = 1_800_000_000_000
const SHOT = new File(["png"], "image.png", { type: "image/png", lastModified: NOW - 7 })
const STEMS = { image: "Pasted image 2026-01-05 09.03.07", file: "Pasted file 2026-01-05 09.03.07" }

describe("clipboardFiles", () => {
	it("reads files, else the items of kind file, else nothing", () => {
		const notes = new File(["a"], "notes.txt")

		expect(clipboardFiles(data([notes]))).toEqual([notes])
		expect(
			clipboardFiles(
				data(
					[],
					[
						{ kind: "string", getAsFile: () => null },
						{ kind: "file", getAsFile: () => SHOT },
						{ kind: "file", getAsFile: () => null }
					]
				)
			)
		).toEqual([SHOT])
		expect(clipboardFiles(data([], [{ kind: "string", getAsFile: () => null }]))).toEqual([])
		expect(clipboardFiles(null)).toEqual([])
	})
})

describe("clipboardEntries", () => {
	it("collects the entries of file items where the browser gives them", () => {
		const entry = { name: "photos", isDirectory: true } as FileSystemEntry

		expect(
			clipboardEntries(
				data(
					[],
					[
						{ kind: "file", getAsFile: () => null, webkitGetAsEntry: () => entry },
						{ kind: "file", getAsFile: () => null, webkitGetAsEntry: () => null },
						{ kind: "file", getAsFile: () => null },
						{ kind: "string", getAsFile: () => null, webkitGetAsEntry: () => entry }
					]
				)
			)
		).toEqual([entry])
		expect(clipboardEntries(null)).toEqual([])
	})
})

describe("isUnnamedClipboardFile", () => {
	it("holds for a nameless file and the browsers' image placeholder made as it was pasted", () => {
		expect(isUnnamedClipboardFile(SHOT, NOW)).toBe(true)
		expect(isUnnamedClipboardFile(new File(["x"], "", { type: "image/jpeg" }), NOW)).toBe(true)
		expect(isUnnamedClipboardFile(new File(["x"], "", { type: "" }), NOW)).toBe(true)
		expect(isUnnamedClipboardFile(new File(["x"], "holiday.png", { type: "image/png", lastModified: NOW }), NOW)).toBe(false)
		expect(isUnnamedClipboardFile(new File(["x"], "image.txt", { type: "text/plain", lastModified: NOW }), NOW)).toBe(false)
	})

	// A file really named image.png, copied in a file manager, keeps its older modification time and its name.
	it("fails for a placeholder-named image last modified before the paste", () => {
		expect(isUnnamedClipboardFile(new File(["x"], "image.png", { type: "image/png", lastModified: NOW - 3_600_000 }), NOW)).toBe(false)
	})
})

describe("clipboardNameTime", () => {
	it("is the local date and time without a colon", () => {
		expect(clipboardNameTime(new Date(2026, 0, 5, 9, 3, 7))).toBe("2026-01-05 09.03.07")
	})
})

describe("namePastedFiles", () => {
	it("names unnamed images by their type, numbering from the second, and keeps named files as they are", () => {
		const named = new File(["a"], "notes.txt")
		const jpeg = new File(["j"], "", { type: "image/jpeg" })
		const [first, kept, second] = namePastedFiles([SHOT, named, jpeg], STEMS, NOW)

		expect(first?.name).toBe("Pasted image 2026-01-05 09.03.07.png")
		expect(first?.type).toBe("image/png")
		expect(first?.lastModified).toBe(NOW - 7)
		expect(first?.size).toBe(SHOT.size)
		expect(kept).toBe(named)
		expect(second?.name).toBe("Pasted image 2026-01-05 09.03.07 (2).jpg")
	})

	it("falls back to the placeholder's extension, or none", () => {
		const [odd, bare] = namePastedFiles(
			[new File(["x"], "image.qoi", { type: "image/x-unknown", lastModified: NOW }), new File(["x"], "", { type: "image/x-raw" })],
			{ image: "Pasted image", file: "Pasted file" },
			NOW
		)

		expect(odd?.name).toBe("Pasted image.qoi")
		expect(bare?.name).toBe("Pasted image (2)")
	})

	it("names a nameless file other than an image by the file stem, numbered on its own", () => {
		const [image, file, other] = namePastedFiles(
			[SHOT, new File(["x"], "", { type: "application/pdf" }), new File(["x"], "", { type: "" })],
			STEMS,
			NOW
		)

		expect(image?.name).toBe("Pasted image 2026-01-05 09.03.07.png")
		expect(file?.name).toBe("Pasted file 2026-01-05 09.03.07.pdf")
		expect(other?.name).toBe("Pasted file 2026-01-05 09.03.07 (2)")
	})
})

describe("isNativePasteKey", () => {
	const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }

	it("holds for mod+v, with or without Shift, and Shift+Insert", () => {
		expect(isNativePasteKey({ ...none, key: "v", ctrlKey: true })).toBe(true)
		expect(isNativePasteKey({ ...none, key: "V", metaKey: true, shiftKey: true })).toBe(true)
		expect(isNativePasteKey({ ...none, key: "Insert", shiftKey: true })).toBe(true)
	})

	it("fails for any other binding", () => {
		expect(isNativePasteKey({ ...none, key: "v" })).toBe(false)
		expect(isNativePasteKey({ ...none, key: "v", ctrlKey: true, altKey: true })).toBe(false)
		expect(isNativePasteKey({ ...none, key: "p", ctrlKey: true })).toBe(false)
		expect(isNativePasteKey({ ...none, key: "Insert" })).toBe(false)
	})
})
