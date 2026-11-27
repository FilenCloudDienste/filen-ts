import { describe, expect, it } from "vitest"
import type { Dir, File, ParentUuid } from "@filen/sdk-rs"
import { NO_HIDING, orderSlideshowFiles, type SlideshowOrderRules } from "@/features/preview/lib/slideshowOrder"
import { testUuid } from "@/tests/support/uuid"

// A slideshow's subdirectories' order, run in the worker: directory path then natural name, without what the opening
// listing hides.

const ROOT = testUuid("root")

function mockDir(uuid: string, parent: ParentUuid, name: string): Dir {
	return {
		uuid: testUuid(uuid),
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

function mockFile(uuid: string, parent: ParentUuid, name: string, mime = "image/jpeg"): File {
	return {
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime, modified: 1n, size: 1_024n, key: "k", version: 2 } }
	}
}

function names(files: readonly File[]): string[] {
	return files.map(file => (file.meta.type === "decoded" ? file.meta.data.name : file.uuid))
}

const keepAll = (): boolean => true

function order(dirs: Dir[], files: File[], rules: SlideshowOrderRules = NO_HIDING): File[] {
	return orderSlideshowFiles(dirs, files, rules, keepAll)
}

describe("orderSlideshowFiles", () => {
	it("orders by directory path then natural name", () => {
		const b = mockDir("b", ROOT, "B")
		const a = mockDir("a", ROOT, "A")
		const ab = mockDir("ab", a.uuid, "Inner")
		const a10 = mockDir("a10", ROOT, "A10")
		const a2 = mockDir("a2", ROOT, "A2")

		const ordered = order(
			[b, ab, a10, a, a2],
			[
				mockFile("f1", b.uuid, "x.jpg"),
				mockFile("f2", ab.uuid, "x.jpg"),
				mockFile("f3", a.uuid, "img10.jpg"),
				mockFile("f4", a.uuid, "img2.jpg"),
				mockFile("f5", ROOT, "top.jpg"),
				mockFile("f6", a10.uuid, "x.jpg"),
				mockFile("f7", a2.uuid, "x.jpg")
			]
		)

		expect(ordered.map(file => file.uuid)).toEqual(["f5", "f4", "f3", "f2", "f7", "f6", "f1"].map(testUuid))
	})

	it("orders a large directory's names as the collator does", () => {
		const collator = new Intl.Collator(undefined, { numeric: true })
		const pool = ["IMG_10.jpg", "img_2.jpg", "Äpfel.jpg", "apfel.jpg", "_x.jpg", "z.jpg", "IMG_2.jpg", "b 1.jpg", "b1.jpg", "é.jpg"]
		const files = Array.from({ length: 500 }, (_, i) =>
			mockFile(`n${String(i)}`, ROOT, `${String(i % 7)}-${pool[i % pool.length] ?? ""}`)
		)
		const expected = [...names(files)].sort((a, b) => collator.compare(a, b))

		expect(names(order([], files))).toEqual(expected)
	})

	it("keeps only the files `keep` admits", () => {
		const files = [mockFile("a", ROOT, "a.jpg"), mockFile("b", ROOT, "b.pdf", "application/pdf")]

		expect(names(orderSlideshowFiles([], files, NO_HIDING, item => item.data.uuid === testUuid("b")))).toEqual(["b.pdf"])
	})

	it("drops dot-files and files inside dot-directories only when hideDotFiles", () => {
		const dot = mockDir("dot", ROOT, ".git")
		const deep = mockDir("deep", dot.uuid, "objects")
		const files = [
			mockFile("a", ROOT, "a.jpg"),
			mockFile("b", ROOT, ".b.jpg"),
			mockFile("c", dot.uuid, "c.jpg"),
			mockFile("d", deep.uuid, "d.jpg")
		]

		expect(names(order([dot, deep], files, { hideDotFiles: true, dotFilenRoot: null }))).toEqual(["a.jpg"])
		expect(names(order([dot, deep], files))).toEqual([".b.jpg", "a.jpg", "c.jpg", "d.jpg"])
	})

	it("drops the root .filen when the listing hides it, and keeps it when the listing shows it", () => {
		const dotFilen = mockDir("dotfilen", ROOT, ".filen")
		const photos = mockDir("photos", dotFilen.uuid, "photos")
		const other = mockDir("other", ROOT, "Other")
		const nested = mockDir("nested", other.uuid, ".filen")
		const dirs = [dotFilen, photos, other, nested]
		const files = [mockFile("a", photos.uuid, "a.jpg"), mockFile("b", nested.uuid, "b.jpg"), mockFile("c", ROOT, "c.jpg")]

		// Only the root's own `.filen`: one nested elsewhere stays.
		expect(names(order(dirs, files, { hideDotFiles: false, dotFilenRoot: ROOT }))).toEqual(["c.jpg", "b.jpg"])
		expect(names(order(dirs, files))).toEqual(["c.jpg", "a.jpg", "b.jpg"])
	})
})
