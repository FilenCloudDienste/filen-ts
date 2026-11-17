import { describe, expect, it } from "vitest"
import {
	EBOOK_TEXT_SIZES,
	ebookMetadataSections,
	ebookPageSize,
	ebookSizeCounts,
	ebookTextStep
} from "@/features/preview/lib/ebookLayout.logic"

describe("the e-book page geometry", () => {
	it("is the pages area less its gutters, in points, quantized and clamped", () => {
		// (1048 - 48) px × 0.75 = 750 pt, clamped to 720; (848 - 48) × 0.75 = 600 pt.
		expect(ebookPageSize(1048, 848)).toEqual({ width: 720, height: 608 })
		expect(ebookPageSize(400, 500)).toEqual({ width: 280, height: 360 })
		expect(ebookPageSize(800, 3000)).toEqual({ width: 560, height: 1080 })
		expect(ebookPageSize(0, 0)).toEqual({ width: 280, height: 360 })
	})

	it("lays out again only for a width step or a fifth of the height", () => {
		const laid = { width: 560, height: 800 }

		expect(ebookSizeCounts(laid, { width: 560, height: 800 })).toBe(false)
		expect(ebookSizeCounts(laid, { width: 576, height: 800 })).toBe(true)
		// A find bar, a keyboard, a URL bar: a small height change.
		expect(ebookSizeCounts(laid, { width: 560, height: 704 })).toBe(false)
		expect(ebookSizeCounts(laid, { width: 560, height: 640 })).toBe(true)
	})

	it("steps the text size within its list", () => {
		expect(ebookTextStep(11, 1)).toBe(12)
		expect(ebookTextStep(12, 1)).toBe(14)
		expect(ebookTextStep(11, -1)).toBe(10)
		expect(ebookTextStep(EBOOK_TEXT_SIZES[0], -1)).toBe(EBOOK_TEXT_SIZES[0])
		expect(ebookTextStep(18, 1)).toBe(18)
	})

	it("gives the book's properties as MetadataCard data", () => {
		const labels = { title: "Title", author: "Author", subject: "Subject", format: "Format", pages: "Pages" }

		expect(ebookMetadataSections({ format: "FictionBook2", title: "A Book", author: "Ann Writer", subject: null }, 42, labels)).toEqual(
			[
				{
					fields: [
						{ label: "Title", value: "A Book" },
						{ label: "Author", value: "Ann Writer" },
						{ label: "Format", value: "FictionBook (FB2)" },
						{ label: "Pages", value: "42" }
					]
				}
			]
		)
		expect(structuredClone(ebookMetadataSections({ format: "EPUB", title: null, author: null, subject: null }, 1, labels))).toEqual([
			{
				fields: [
					{ label: "Format", value: "EPUB" },
					{ label: "Pages", value: "1" }
				]
			}
		])
	})
})
