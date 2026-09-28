import { describe, expect, it } from "vitest"
import { previewTitleSplitIndex } from "@/features/preview/lib/previewTitle"

const TAIL = 16

describe("previewTitleSplitIndex", () => {
	it("leaves a name no longer than the tail whole", () => {
		expect(previewTitleSplitIndex("short.jpg", TAIL)).toBe(0)
		expect(previewTitleSplitIndex("a".repeat(TAIL), TAIL)).toBe(0)
	})

	it("splits a plain name exactly the tail length from its end", () => {
		const name = "Holiday photos from the beach trip.jpg"

		expect(previewTitleSplitIndex(name, TAIL)).toBe(name.length - TAIL)
	})

	it("never splits an emoji's surrogate pair", () => {
		const name = `Holiday 😀${"x".repeat(TAIL - 1)}`
		const splitAt = previewTitleSplitIndex(name, TAIL)

		// The naive cut falls between the pair's two halves.
		expect(name.length - TAIL).toBe(splitAt + 1)
		expect(name.slice(0, splitAt)).toBe("Holiday ")
		expect(name.slice(splitAt)).toBe(`😀${"x".repeat(TAIL - 1)}`)
	})

	it("keeps a joined emoji sequence in one half", () => {
		const family = "👨‍👩‍👧"
		const name = `Trip ${family}${"x".repeat(TAIL - 3)}`
		const splitAt = previewTitleSplitIndex(name, TAIL)

		expect(name.slice(splitAt).startsWith(family)).toBe(true)
	})
})
