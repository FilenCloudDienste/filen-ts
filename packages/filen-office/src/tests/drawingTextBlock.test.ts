import { describe, expect, it } from "vitest"
import { layoutBlock } from "../core/drawingml/textBlock"

// Block text layout with a fixed advance of 10 per character (the ellipsis included).

type Trimming = Parameters<typeof layoutBlock>[6]

const ADVANCE = 10

function measure(text: string): number {
	return Array.from(text).length * ADVANCE
}

function wrapped(source: string, width: number, height = 0, lineLimit = true, trimming: Trimming = "none"): string[] {
	return layoutBlock(source, width, height, ADVANCE, true, lineLimit, trimming, measure)
}

describe("layoutBlock wrapping", () => {
	it("wraps at spaces and drops the spaces at a break", () => {
		expect(wrapped("aa bb cc", 50)).toEqual(["aa bb", "cc"])
		expect(wrapped("aaa bb", 40)).toEqual(["aaa", "bb"])
	})

	it("breaks a word wider than the line between characters", () => {
		expect(wrapped("abcdefg", 30)).toEqual(["abc", "def", "g"])
		expect(wrapped("x abcdefg", 30)).toEqual(["x", "abc", "def", "g"])
	})

	it("starts a paragraph at each newline", () => {
		expect(wrapped("ab\ncd", 50)).toEqual(["ab", "cd"])
		expect(layoutBlock("ab\n\ncd", 0, 0, ADVANCE, false, true, "none", measure)).toEqual(["ab", "", "cd"])
	})

	it("treats width 0 and height 0 as unbounded", () => {
		expect(wrapped("a long line here\nx\ny", 0, 0, true, "character")).toEqual(["a long line here", "x", "y"])
	})
})

describe("layoutBlock height", () => {
	const source = "a\nb\nc"

	it("keeps whole lines at an exact multiple of the line height either way", () => {
		expect(wrapped(source, 0, 20, true)).toEqual(["a", "b"])
		expect(wrapped(source, 0, 20, false)).toEqual(["a", "b"])
	})

	it("keeps a partial line only without lineLimit", () => {
		expect(wrapped(source, 0, 25, true)).toEqual(["a", "b"])
		expect(wrapped(source, 0, 25, false)).toEqual(["a", "b", "c"])
	})

	it("cuts wrapped lines past the height", () => {
		expect(wrapped("aa bb cc", 20, 20, true)).toEqual(["aa", "bb"])
	})
})

describe("layoutBlock trimming", () => {
	// "ab cd" fills the 50 wide line exactly; the next paragraph is cut, so the kept line is trimmed.
	const lastKept = (trimming: Trimming): string[] => wrapped("ab cd\nx", 50, 10, true, trimming)

	it("trims the last kept line when text is cut", () => {
		expect(lastKept("none")).toEqual(["ab cd"])
		expect(lastKept("character")).toEqual(["ab c"])
		expect(lastKept("word")).toEqual(["ab"])
		expect(lastKept("ellipsisCharacter")).toEqual(["ab c…"])
		expect(lastKept("ellipsisWord")).toEqual(["ab…"])
		expect(lastKept("ellipsisPath")).toEqual(["ab…cd"])
	})

	it("keeps all of a cut line that has room for the ellipsis", () => {
		const roomy = (trimming: Trimming): string[] => wrapped("ab cd\nx", 60, 10, true, trimming)

		expect(roomy("ellipsisCharacter")).toEqual(["ab cd…"])
		expect(roomy("ellipsisWord")).toEqual(["ab cd…"])
		expect(roomy("character")).toEqual(["ab c"])
		expect(roomy("ellipsisPath")).toEqual(["ab…cd"])
	})

	it("trims only the last kept line when text is cut", () => {
		expect(wrapped("ab cd\nef gh\nx", 50, 20, true, "character")).toEqual(["ab cd", "ef g"])
	})

	// An unwrapped 60 wide line in a 40 wide box.
	const overWide = (trimming: Trimming): string[] => layoutBlock("ab cde", 40, 0, ADVANCE, false, true, trimming, measure)

	it("trims a line wider than an unwrapped box", () => {
		expect(overWide("none")).toEqual(["ab cde"])
		expect(overWide("character")).toEqual(["ab c"])
		expect(overWide("word")).toEqual(["ab"])
		expect(overWide("ellipsisCharacter")).toEqual(["ab…"])
		expect(overWide("ellipsisWord")).toEqual(["ab…"])
		expect(overWide("ellipsisPath")).toEqual(["ab…e"])
	})

	it("leaves an unwrapped line that fits", () => {
		expect(layoutBlock("abc", 40, 0, ADVANCE, false, true, "ellipsisCharacter", measure)).toEqual(["abc"])
	})

	it("falls back to the ellipsis alone when nothing else fits", () => {
		expect(layoutBlock("abcdef", 10, 0, ADVANCE, false, true, "ellipsisCharacter", measure)).toEqual(["…"])
		expect(layoutBlock("abcdef", 10, 0, ADVANCE, false, true, "ellipsisPath", measure)).toEqual(["…"])
		expect(layoutBlock("abcdef", 5, 0, ADVANCE, false, true, "character", measure)).toEqual([""])
	})
})
