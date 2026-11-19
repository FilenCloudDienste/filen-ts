// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { NotesParagraph } from "../core/presentation/output"
import { NotesText } from "../react/presentation/notes/NotesText"

// The presenter view's speaker notes: indents in em clamped to the paragraph's box, a bullet hanging in the first-line
// indent or followed by a no-break space, direction and alignment, an empty paragraph's line, and the run formatting.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
	host = document.createElement("div")
	document.body.append(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
})

function render(paragraphs: readonly NotesParagraph[]): HTMLParagraphElement[] {
	act(() => {
		root.render(<NotesText paragraphs={paragraphs} />)
	})

	return [...host.querySelectorAll("p")]
}

describe("NotesText", () => {
	it("hangs a bullet in the first-line indent", () => {
		const [p] = render([{ level: 0, start: 1.5, first: -1.5, marker: "•", runs: [{ text: "Point" }] }])
		const marker = p?.firstElementChild as HTMLElement | null

		expect(p?.style.paddingInlineStart).toBe("1.5em")
		expect(p?.style.textIndent).toBe("-1.5em")
		expect(marker?.textContent).toBe("•")
		expect(marker?.style.display).toBe("inline-block")
		expect(marker?.style.minWidth).toBe("1.5em")
		expect(marker?.style.textIndent).toBe("0px")
	})

	it("follows a marker with a no-break space when the first line is not outdented", () => {
		const [p] = render([{ level: 0, start: 0, first: 0, marker: "1.", runs: [{ text: "One" }] }])
		const marker = p?.firstElementChild as HTMLElement | null

		expect(marker?.textContent).toBe("1. ")
		expect(marker?.getAttribute("style")).toBeNull()
		expect(p?.textContent).toBe("1. One")
	})

	it("never puts the marker left of the paragraph's box", () => {
		const [negative, outdented] = render([
			{ level: 0, start: -2, first: -1, marker: "•", runs: [{ text: "a" }] },
			{ level: 1, start: 1, first: -3, marker: "•", runs: [{ text: "b" }] }
		])

		// A negative margin is 0, and the first line then can not go left of it: no hanging marker.
		expect(negative?.style.paddingInlineStart).toBe("0em")
		expect(negative?.style.textIndent).toBe("0em")
		expect(negative?.firstElementChild?.textContent).toBe("• ")
		// An outdent past the margin is cut at the margin.
		expect(outdented?.style.paddingInlineStart).toBe("1em")
		expect(outdented?.style.textIndent).toBe("-1em")
		expect((outdented?.firstElementChild as HTMLElement | null)?.style.minWidth).toBe("1em")
	})

	it("takes the paragraph's direction and alignment, and gives an empty paragraph its line", () => {
		const paragraphs = render([
			{ level: 0, start: 0, first: 0, rtl: true, runs: [{ text: "שלום" }] },
			{ level: 0, start: 0, first: 0, align: "ctr", runs: [{ text: "c" }] },
			{ level: 0, start: 0, first: 0, align: "r", runs: [{ text: "r" }] },
			{ level: 0, start: 0, first: 0, align: "just", runs: [{ text: "j" }] },
			{ level: 0, start: 0, first: 0, runs: [] }
		])

		expect(paragraphs.map(p => p.getAttribute("dir"))).toEqual(["rtl", null, null, null, null])
		expect(paragraphs.map(p => p.style.textAlign)).toEqual(["", "center", "right", "justify", ""])
		expect(paragraphs[4]?.innerHTML).toBe("<br>")
	})

	it("formats runs: bold, italic, underline with strikethrough, superscript and subscript", () => {
		const [p] = render([
			{
				level: 0,
				start: 0,
				first: 0,
				runs: [
					{ text: "plain" },
					{ text: "bold", b: true },
					{ text: "italic", i: true },
					{ text: "lined", u: true, strike: true },
					{ text: "2", script: "sup" },
					{ text: "i", script: "sub", b: true }
				]
			}
		])
		const children = [...(p?.children ?? [])] as HTMLElement[]

		expect(children.map(child => child.tagName.toLowerCase())).toEqual(["span", "span", "span", "span", "sup", "sub"])
		expect(children[0]?.getAttribute("style")).toBeNull()
		expect(children[1]?.style.fontWeight).toBe("700")
		expect(children[2]?.style.fontStyle).toBe("italic")
		expect(children[3]?.style.textDecorationLine).toBe("underline line-through")
		expect(children[4]?.getAttribute("style")).toBeNull()
		expect(children[5]?.style.fontWeight).toBe("700")
		expect(p?.textContent).toBe("plainbolditaliclined2i")
	})
})
