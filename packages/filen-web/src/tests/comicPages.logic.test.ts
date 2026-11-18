import { describe, expect, it } from "vitest"
import type { EntryAccess } from "@filen/sdk-rs"
import { comicPages, comicViews, largestSolidBlock, onScreen, viewLabel, viewOf } from "@/features/comics/lib/pages.logic"
import { comicFormatOfName, COMIC_EXTENSIONS } from "@/features/drive/lib/archiveFormats"
import { previewType } from "@/features/drive/lib/preview.logic"
import { gateFor } from "@/features/archive/lib/archiveGate.logic"
import { storeOf } from "@/tests/support/archiveEntries"
import { linkedFileItem } from "@/tests/fixtures/sdk"

const DIRECT: EntryAccess = { type: "direct", packedBytes: 1n }

describe("comicPages", () => {
	it("takes the page images in the natural order of their paths, without macOS metadata, directories or other files", () => {
		const store = storeOf([
			{ path: "issue/p10.jpg", access: DIRECT },
			{ path: "issue/p2.jpg", access: DIRECT },
			{ path: "issue/", access: DIRECT },
			{ path: "issue/p1.png", access: DIRECT },
			{ path: "ComicInfo.xml", access: DIRECT },
			{ path: "__MACOSX/issue/._p1.png", access: DIRECT, skip: "macMetadata" },
			{ path: "a-cover.webp", access: DIRECT }
		])

		expect(comicPages(store).map(slot => store.name(slot))).toEqual(["a-cover.webp", "p1.png", "p2.jpg", "p10.jpg"])
	})

	it("leaves out a page the SDK cannot read alone: a single compressed file's", () => {
		const store = storeOf([
			{ path: "p1.jpg", access: DIRECT },
			{ path: "p2.jpg", access: { type: "sequential" } }
		])

		expect(comicPages(store).map(slot => store.name(slot))).toEqual(["p1.jpg"])
	})

	it("reads a bare tar's pages, which list as sequential and read by range (.cbt)", () => {
		const store = storeOf(
			[
				{ path: "p2.jpg", access: { type: "sequential" } },
				{ path: "p1.jpg", access: { type: "sequential" } }
			],
			undefined,
			true
		)

		expect(store.membersMapped).toBe(true)
		expect(comicPages(store).map(slot => store.name(slot))).toEqual(["p1.jpg", "p2.jpg"])
	})

	it("finds the largest solid block its pages lie in", () => {
		const solid = (estimated: number): EntryAccess => ({
			type: "solidBlock",
			skippedBytes: 1n,
			estimatedPackedBytes: BigInt(estimated),
			blockPackedBytes: BigInt(estimated)
		})
		const store = storeOf([
			{ path: "p1.jpg", access: DIRECT },
			{ path: "p2.jpg", access: solid(700) },
			{ path: "p3.jpg", access: solid(900) }
		])

		expect(largestSolidBlock(store, comicPages(store))).toBe(900)
		expect(largestSolidBlock(storeOf([{ path: "p.jpg", access: DIRECT }]), [0])).toBe(0)
	})
})

describe("comicViews", () => {
	const none = new Set<number>()

	it("shows a page a view in single layout", () => {
		expect(comicViews(3, "single", none)).toEqual([[0], [1], [2]])
	})

	it("pairs pages after the cover, and leaves an odd last page alone", () => {
		expect(comicViews(6, "spread", none)).toEqual([[0], [1, 2], [3, 4], [5]])
		expect(comicViews(5, "spread", none)).toEqual([[0], [1, 2], [3, 4]])
		expect(comicViews(1, "spread", none)).toEqual([[0]])
		expect(comicViews(0, "spread", none)).toEqual([])
	})

	it("shows a landscape page alone and pairs the pages after it anew", () => {
		expect(comicViews(7, "spread", new Set([2]))).toEqual([[0], [1], [2], [3, 4], [5, 6]])
		expect(comicViews(5, "spread", new Set([1]))).toEqual([[0], [1], [2, 3], [4]])
	})

	it("lands a jump on the view holding the page, and labels a spread by its pages", () => {
		const views = comicViews(6, "spread", none)

		expect(viewOf(views, 4)).toBe(2)
		expect(viewOf(views, 9)).toBe(-1)
		expect(viewLabel([3, 4])).toBe("4–5")
		expect(viewLabel([0])).toBe("1")
	})

	it("puts the earlier page of a spread on the right when reading right to left", () => {
		expect(onScreen([1, 2], "rtl")).toEqual([2, 1])
		expect(onScreen([1, 2], "ltr")).toEqual([1, 2])
	})
})

describe("comic book names", () => {
	it("open in the comic reader, a .cbr too", () => {
		for (const extension of COMIC_EXTENSIONS) {
			expect(previewType(linkedFileItem(`issue.${extension}`))).toBe("comic")
		}
	})

	it("gate by the format their name says: a .cbz lists at once, a big .cbt or .cbr waits", () => {
		const big = 50 * 1024 * 1024

		expect(gateFor(comicFormatOfName("a.cbz"), big, false)).toBe("list")
		expect(gateFor(comicFormatOfName("a.CB7"), big, false)).toBe("list")
		expect(gateFor(comicFormatOfName("a.cbt"), big, false)).toBe("gate")
		expect(gateFor(comicFormatOfName("a.cbr"), big, false)).toBe("gate")
		expect(comicFormatOfName("a.zip")).toBeNull()
	})
})
