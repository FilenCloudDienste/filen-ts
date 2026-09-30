import { describe, it, expect, vi } from "vitest"
import { parse } from "node-html-better-parser"
import striptags from "striptags"
import { createNotePreviewFromContentText, decodeHtmlEntities, sortNoteHistory } from "@filen/shared"

vi.mock("node-html-better-parser", async importOriginal => {
	const actual = await importOriginal<typeof import("node-html-better-parser")>()

	return {
		...actual,
		parse: vi.fn(actual.parse)
	}
})

describe("createNotePreviewFromContentText", () => {
	describe("rich text", () => {
		it("should strip HTML tags and return first line", () => {
			const result = createNotePreviewFromContentText("rich", "<p>Hello World</p>\n<p>Second line</p>")

			expect(result).toBe("Hello World")
		})

		it("should split on <p><br></p> when present", () => {
			const result = createNotePreviewFromContentText("rich", "<p>First paragraph</p><p><br></p><p>Second paragraph</p>")

			expect(result).toBe("First paragraph")
		})

		it("should truncate to 128 characters", () => {
			const longText = "<p>" + "a".repeat(200) + "</p>"
			const result = createNotePreviewFromContentText("rich", longText)

			expect(result.length).toBeLessThanOrEqual(128)
		})

		it("decodes the text's entities after stripping tags", () => {
			expect(createNotePreviewFromContentText("rich", "<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry")
			expect(createNotePreviewFromContentText("rich", "<p>Fix &lt;Header&gt;</p><p><br></p><p>next</p>")).toBe("Fix <Header>")
		})

		it("keeps a typed entity literal (&amp;lt; reads as &lt;)", () => {
			expect(createNotePreviewFromContentText("rich", "<p>&amp;lt;</p>")).toBe("&lt;")
		})
	})

	describe("checklist", () => {
		it("should extract first non-empty list item", () => {
			const html = "<ul data-checked=\"false\"><li>First item</li><li>Second item</li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("First item")
		})

		it("should skip empty items", () => {
			const html = "<ul data-checked=\"false\"><li></li><li>Actual item</li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("Actual item")
		})

		it("should return empty string for empty checklist", () => {
			const html = "<ul data-checked=\"false\"><li></li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("")
		})

		it("decodes the row text instead of showing its entities", () => {
			const html = "<ul data-checked=\"false\"><li>Tom &amp; Jerry</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Tom & Jerry")
		})

		it("keeps an escaped tag-like row as text (decoded after tags are gone, not stripped)", () => {
			const html = "<ul data-checked=\"true\"><li>Fix &lt;Header&gt;</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Fix <Header>")
		})

		it("skips an empty first row (<br>) and previews the first row with text", () => {
			const html = "<ul data-checked=\"false\"><li><br></li><li>Milk</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Milk")
		})

		it("reads a row older mobile builds stored unescaped as it was typed", () => {
			const html = "<ul data-checked=\"false\"><li>cut&copy</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("cut&copy")
		})

		it("truncates the row to 128 characters", () => {
			const html = `<ul data-checked="false"><li>${"&amp;".repeat(200)}</li></ul>`

			expect(createNotePreviewFromContentText("checklist", html)).toBe("&".repeat(128))
		})

		// Previews are made for every saved or received edit, so they must not parse the whole note.
		it("builds no document", () => {
			const html = `<ul data-checked="false"><li><br></li><li>Milk</li>${"<li>more</li>".repeat(1000)}</ul>`

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Milk")
			expect(parse).not.toHaveBeenCalled()
		})

		// Rows older mobile builds stored unescaped can hold one; the parser's tag pattern took seconds to
		// minutes on such a row, on every received edit of the note.
		it("previews past a row with a \"<\" that starts no tag, quickly, and shows that row as typed", () => {
			const row = "Fix the bug where count<limit fails on second try"
			const start = performance.now()

			expect(createNotePreviewFromContentText("checklist", `<ul data-checked="false"><li>Milk</li><li>${row}</li></ul>`)).toBe("Milk")
			expect(createNotePreviewFromContentText("checklist", `<ul data-checked="false"><li>${row}</li><li>Milk</li></ul>`)).toBe(row)
			expect(performance.now() - start).toBeLessThan(50)
		})
	})

	describe("other types", () => {
		it("should strip tags and return first line", () => {
			const result = createNotePreviewFromContentText("other", "Line 1\nLine 2\nLine 3")

			expect(result).toBe("Line 1")
		})

		it("should truncate to 128 characters", () => {
			const result = createNotePreviewFromContentText("other", "a".repeat(200))

			expect(result.length).toBeLessThanOrEqual(128)
		})
	})

	describe("edge cases", () => {
		it("should return empty string for undefined content", () => {
			expect(createNotePreviewFromContentText("rich")).toBe("")
		})

		it("should return empty string for empty content", () => {
			expect(createNotePreviewFromContentText("rich", "")).toBe("")
		})
	})
})

// The preview stops stripping once its first 128 characters are settled; it must match stripping and decoding
// the whole first segment.
describe("createNotePreviewFromContentText matches the whole-segment preview", () => {
	function wholeSegmentPreview(type: "rich" | "other", content: string): string {
		if (type === "rich") {
			const segment =
				content.indexOf("<p><br></p>") === -1 ? (content.split("\n")[0] ?? "") : (content.split("<p><br></p>")[0] ?? "")

			return decodeHtmlEntities(striptags(segment)).slice(0, 128)
		}

		return striptags(content.split("\n")[0] ?? "").slice(0, 128)
	}

	function expectSame(content: string): void {
		expect(createNotePreviewFromContentText("rich", content)).toBe(wholeSegmentPreview("rich", content))
		expect(createNotePreviewFromContentText("other", content)).toBe(wholeSegmentPreview("other", content))
	}

	// Places `straddle` so it starts `before` characters ahead of the 4096 chunk cut.
	function atCut(straddle: string, before: number, tail = "<p>" + "tail text ".repeat(600) + "</p>"): string {
		return "x".repeat(4096 - before) + straddle + tail
	}

	const prose = "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(500) + "</p>"

	it("a long single-segment rich note", () => {
		expect(prose.length).toBeGreaterThan(4096 * 4)
		expectSame(prose)
		expectSame(prose.repeat(3))
	})

	it("a tag, a quoted \">\", a comment and an entity straddling the chunk cut", () => {
		for (let before = 1; before < 12; before++) {
			expectSame(atCut("<span class=\"a\">", before))
			expectSame(atCut("<a title=\"1 > 0\" href='x>y'>", before))
			expectSame(atCut("<!-- a > b -- c -->", before))
			expectSame(atCut("&amp;&lt;&#65;&#x42;", before))
		}
	})

	it("the stripped text reaching 128 characters right at the cut", () => {
		for (let pad = 0; pad < 8; pad++) {
			const lead = "<b>" + "t".repeat(4096 - 131 + pad - 3) + "</b>"

			expectSame(lead + "&am" + "p;" + "y".repeat(5000))
			expectSame("<p>" + "z".repeat(125 + pad) + "&amp;" + "<i>" + "q".repeat(8000) + "</i></p>")
		}
	})

	it("an \"&\" followed only by alphanumerics right at the chunk end", () => {
		expectSame("<p>" + "a".repeat(4096 - 3 - 3) + "&am" + "p;" + "b".repeat(5000) + "</p>")
		expectSame("<p>" + "a".repeat(4096 - 3 - 4) + "&#12" + "3;" + "b".repeat(5000) + "</p>")
		expectSame("<p>" + "a".repeat(4096 - 3 - 4) + "&#x4" + "1;" + "b".repeat(5000) + "</p>")
		expectSame("<p>" + "a".repeat(4096 - 3 - 3) + "&am" + "pz" + "b".repeat(5000) + "</p>")
	})

	it("a large data: image tag before the text", () => {
		expectSame("<p><img src=\"data:image/png;base64," + "QUJD".repeat(5000) + "\">Caption &amp; more</p>" + prose)
	})

	it("fewer than 128 visible characters in a long note", () => {
		expectSame("<p><img src=\"data:image/png;base64," + "QUJD".repeat(5000) + "\">Short &amp; sweet</p>")
		expectSame("<p>" + "<b></b>".repeat(3000) + "tiny</p>")
	})

	it("a single early \"&\" followed by long plain prose", () => {
		expectSame("<p>Q&amp;A " + "plain words only ".repeat(1000) + "</p>")
		expectSame("<p>Q&A " + "plain words only ".repeat(1000) + "</p>")
	})

	it("a surrogate pair at the chunk cut and at the 128 cut", () => {
		expectSame("<p>" + "a".repeat(4096 - 3 - 1) + "😀" + "b".repeat(5000) + "</p>")
		expectSame("<p>" + "a".repeat(127) + "😀" + "b".repeat(5000) + "</p>")
		expectSame("x".repeat(127) + "😀" + "y".repeat(5000))
	})

	it("a long zero-padded numeric reference", () => {
		expectSame("<p>" + "a".repeat(100) + "&#" + "0".repeat(9000) + "65;" + "b".repeat(200) + "</p>")
		expectSame("<p>" + "a".repeat(100) + "&#" + "0".repeat(9000) + "65" + "b".repeat(200) + "</p>")
		expectSame("<p>" + "a".repeat(100) + "&" + "q".repeat(9000) + " " + "b".repeat(200) + "</p>")
	})

	it("notes within one chunk take the whole-segment path", () => {
		expectSame("<p>Hello &amp; <b>bold</b> world</p>")
		expectSame("<p>" + "c".repeat(4000) + "</p>")
	})

	it("other notes with a long first line", () => {
		expectSame("{\"json\":\"" + "v".repeat(10000) + "\"}\nsecond")
		expectSame("<<a>>" + "w".repeat(10000))
		expectSame("< not a tag " + "w".repeat(10000))
	})

	it("first segments cut at newlines and blank paragraphs", () => {
		expectSame("\n")
		expectSame("\nsecond")
		expectSame("<p><br></p>")
		expectSame("<p><br></p><p>after</p>")
		expectSame("<p>a</p>\n<p>b</p><p><br></p><p>c</p>")
		expectSame("<p>a</p><p><br></p><p>b</p>\n<p>c</p><p><br></p>")
		expectSame(("<p>" + "line ".repeat(40) + "</p>\n").repeat(500))
		expectSame(("<p>" + "para ".repeat(40) + "</p><p><br></p>").repeat(500))
	})

	it("random markup mixes", () => {
		let seed = 42
		const next = (max: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648

			return seed % max
		}
		const pieces = ["<p>", "</p>", "<b>", "</b>", "<a href=\"x>y\">", "<!-- c -->", "&amp;", "&lt;", "&#65;", "&", "&am", "p;", "\"", "'", "<", ">", "😀", " ", "text", "#", ";"]

		for (let round = 0; round < 60; round++) {
			let content = ""

			while (content.length < 9000 + next(4000)) {
				content += next(3) === 0 ? "w".repeat(next(200)) : pieces[next(pieces.length)]
			}

			expectSame(content)
		}
	})
})

describe("sortNoteHistory", () => {
	const entry = (id: bigint, editedTimestamp: bigint) => ({ id, editedTimestamp })

	it("sorts newest-first by editedTimestamp, staying in bigint (never Number())", () => {
		const oldest = entry(1n, 1_700_000_000_000n)
		const newest = entry(2n, 1_800_000_000_000n)
		const middle = entry(3n, 1_750_000_000_000n)

		expect(sortNoteHistory([oldest, newest, middle]).map(h => h.id)).toEqual([2n, 3n, 1n])
	})

	it("breaks a timestamp tie by the higher (later) id", () => {
		expect(sortNoteHistory([entry(1n, 5n), entry(2n, 5n)]).map(h => h.id)).toEqual([2n, 1n])
	})

	it("does not mutate the input array", () => {
		const input = [entry(1n, 0n), entry(2n, 1n)]
		const snapshot = [...input]

		sortNoteHistory(input)

		expect(input).toEqual(snapshot)
	})
})
