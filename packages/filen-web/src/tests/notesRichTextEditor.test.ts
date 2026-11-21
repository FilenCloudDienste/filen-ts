// @vitest-environment jsdom
//
// jsdom (per-file pragma, same as notesSanitizeRichText.test.ts): seedRichEditor routes through
// DOMPurify, which is a passthrough without a real `document`. The rest of the suite stays on node.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, render } from "@testing-library/react"
import Quill from "quill"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"
import {
	shouldPropagateRichChange,
	seedRichEditor,
	applyRichReadOnly,
	reflectRichFormats,
	sameRichFormats,
	serializeRichEditor,
	nextListValue,
	nextToggleValue,
	cycleHeaderValue,
	EMPTY_RICH_FORMATS
} from "@/features/notes/components/editor/richTextEditor.logic"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { RichTextEditor } = await import("@/features/notes/components/editor/richTextEditor")
const { registerAction } = await import("@/lib/keymap/registry")
const { APP_ACTIONS } = await import("@/features/shell/lib/keymap")

// The editor binds the shell's app.assistantTransform (its selection transform).
for (const def of APP_ACTIONS) {
	registerAction(def)
}

describe("shouldPropagateRichChange — #39 source gate", () => {
	it("propagates only genuine user edits", () => {
		expect(shouldPropagateRichChange("user")).toBe(true)
	})

	it("never propagates api / silent (programmatic) edits", () => {
		expect(shouldPropagateRichChange("api")).toBe(false)
		expect(shouldPropagateRichChange("silent")).toBe(false)
	})
})

describe("seedRichEditor — sanitize-before-seed", () => {
	it("pastes a sanitized seed, silently — a hostile seed is neutralized", () => {
		const dangerouslyPasteHTML = vi.fn<(html: string, source: string) => void>()

		seedRichEditor({ clipboard: { dangerouslyPasteHTML } }, '<p>hi</p><script>window.__xss = 1</script><img src=x onerror="alert(1)">')

		expect(dangerouslyPasteHTML).toHaveBeenCalledTimes(1)

		const [html, source] = dangerouslyPasteHTML.mock.calls[0] ?? ["", ""]

		expect(source).toBe("silent")
		expect(html).toContain("<p>hi</p>")
		expect(html).not.toContain("<script")
		expect(html).not.toContain("__xss")
		expect(html).not.toContain("onerror")
		expect(html).not.toContain("<img")
	})
})

describe("serializeRichEditor — save egress", () => {
	it("hands Quill 2 lists and code blocks out in Quill 1's on-disk form", () => {
		const innerHTML =
			'<p>x</p><ol><li data-list="checked"><span class="ql-ui" contenteditable="false"></span>A</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>B</li></ol><div class="ql-code-block-container" spellcheck="false"><div class="ql-code-block">a &lt; b</div></div>'

		expect(serializeRichEditor({ innerHTML })).toBe(
			'<p>x</p><ul data-checked="true"><li>A</li></ul><ul><li>B</li></ul><pre class="ql-syntax" spellcheck="false">a &lt; b\n</pre>'
		)
	})

	it("returns content without lists or code blocks unchanged", () => {
		const innerHTML = "<p>hello <strong>world</strong></p>"

		expect(serializeRichEditor({ innerHTML })).toBe(innerHTML)
	})
})

describe("applyRichReadOnly — #40 enforcement", () => {
	it("enables the editor when writable and disables it when read-only", () => {
		const enable = vi.fn<(enabled: boolean) => void>()

		applyRichReadOnly({ enable }, false)
		expect(enable).toHaveBeenLastCalledWith(true)

		applyRichReadOnly({ enable }, true)
		expect(enable).toHaveBeenLastCalledWith(false)
	})
})

describe("reflectRichFormats — narrowing Quill's format map", () => {
	it("narrows a populated format map into the typed active model", () => {
		expect(
			reflectRichFormats({ bold: true, italic: true, header: 2, list: "bullet", "code-block": "plain", link: "https://a.b" })
		).toEqual({
			bold: true,
			italic: true,
			underline: false,
			blockquote: false,
			codeBlock: true,
			header: 2,
			list: "bullet",
			link: "https://a.b"
		})
	})

	it("falls back to inactive for absent / unknown-shaped values", () => {
		expect(reflectRichFormats({ header: 9, list: "weird", link: 42 })).toEqual(EMPTY_RICH_FORMATS)
	})
})

describe("sameRichFormats", () => {
	it("compares every reflected field", () => {
		expect(sameRichFormats(EMPTY_RICH_FORMATS, { ...EMPTY_RICH_FORMATS })).toBe(true)
		expect(sameRichFormats(EMPTY_RICH_FORMATS, { ...EMPTY_RICH_FORMATS, list: "bullet" })).toBe(false)
		expect(sameRichFormats(EMPTY_RICH_FORMATS, { ...EMPTY_RICH_FORMATS, link: "https://a.b" })).toBe(false)
		expect(sameRichFormats(EMPTY_RICH_FORMATS, { ...EMPTY_RICH_FORMATS, header: 1 })).toBe(false)
	})
})

describe("toolbar format-value helpers", () => {
	it("nextToggleValue negates", () => {
		expect(nextToggleValue(false)).toBe(true)
		expect(nextToggleValue(true)).toBe(false)
	})

	it("cycleHeaderValue walks none → H1 → H2 → H3 → none", () => {
		expect(cycleHeaderValue(null)).toBe(1)
		expect(cycleHeaderValue(1)).toBe(2)
		expect(cycleHeaderValue(2)).toBe(3)
		expect(cycleHeaderValue(3)).toBe(false)
	})

	it("nextListValue toggles the active list off and maps a checklist request to unchecked", () => {
		expect(nextListValue("ordered", "ordered")).toBe(false)
		expect(nextListValue("bullet", "bullet")).toBe(false)
		expect(nextListValue("checked", "checklist")).toBe(false)
		expect(nextListValue("unchecked", "checklist")).toBe(false)
		expect(nextListValue(null, "checklist")).toBe("unchecked")
		expect(nextListValue("bullet", "ordered")).toBe("ordered")
	})
})

// The mounted editor (real Quill on jsdom), so the test covers the constructor options the component passes.
function mountEditor(seed: string): Quill {
	const controller: NoteEditorController = {
		status: "ready",
		errorDto: undefined,
		seed,
		remountKey: "note",
		readOnly: false,
		sizeReached: false,
		onChange: () => undefined
	}
	const { container } = render(createElement(RichTextEditor, { controller }))
	const node = container.querySelector(".ql-container")
	const quill = node ? Quill.find(node) : null

	if (!(quill instanceof Quill)) {
		throw new Error("Quill did not mount")
	}

	return quill
}

const PNG = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" })

// The uploader's default handler reads the file with a FileReader before inserting, so give it time to land.
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 50))
	})
}

function hasEmbed(quill: Quill): boolean {
	return quill.getContents().ops.some(op => typeof op.insert === "object")
}

describe("RichTextEditor — only the formats the sanitizer keeps", () => {
	// jsdom has no layout: Quill measures the selection when a paste focuses the editor.
	beforeAll(() => {
		Range.prototype.getBoundingClientRect = () => new DOMRect()
		Range.prototype.getClientRects = () => document.createElement("div").getClientRects()
	})

	afterEach(() => {
		cleanup()
	})

	it("inserts nothing for a pasted image file", async () => {
		const quill = mountEditor("<p>hello</p>")

		quill.setSelection(5, 0, "silent")

		const paste = new Event("paste", { bubbles: true, cancelable: true })

		Object.defineProperty(paste, "clipboardData", { value: { getData: () => "", files: [PNG] } })
		quill.root.dispatchEvent(paste)
		await settle()

		expect(hasEmbed(quill)).toBe(false)
		expect(quill.root.querySelector("img")).toBeNull()
	})

	it("inserts nothing for a dropped image file", async () => {
		const quill = mountEditor("<p>hello</p>")
		const text = quill.root.querySelector("p")?.firstChild

		if (!text) {
			throw new Error("seed did not render")
		}

		Object.defineProperty(document, "caretRangeFromPoint", {
			configurable: true,
			value: () => {
				const range = document.createRange()

				range.setStart(text, 2)
				range.setEnd(text, 2)

				return range
			}
		})

		try {
			const drop = new Event("drop", { bubbles: true, cancelable: true })

			Object.defineProperty(drop, "dataTransfer", { value: { files: [PNG] } })
			quill.root.dispatchEvent(drop)
			await settle()
		} finally {
			Reflect.deleteProperty(document, "caretRangeFromPoint")
		}

		expect(hasEmbed(quill)).toBe(false)
		expect(quill.root.querySelector("img")).toBeNull()
	})

	it("does not keep pasted strike, subscript or superscript", () => {
		const quill = mountEditor("")

		quill.clipboard.dangerouslyPasteHTML(0, "<p><s>struck</s> <sub>low</sub> <sup>high</sup></p>", "user")

		const saved = serializeRichEditor(quill.root)

		expect(saved).not.toMatch(/<(s|sub|sup)>/)
		expect(saved).toContain("struck low high")
		expect(quill.getContents().ops.some(op => op.attributes && ("strike" in op.attributes || "script" in op.attributes))).toBe(false)
	})

	it("round-trips every supported format through the sanitizer unchanged", () => {
		const quill = mountEditor(
			[
				"<h2>Title</h2>",
				'<p><strong>bold</strong> <em>it</em> <u>under</u> <a href="https://filen.io" rel="noopener noreferrer" target="_blank">link</a> <span style="color: rgb(230, 0, 0);">red</span></p>',
				'<p class="ql-align-center">centered</p>',
				"<ol><li>one</li></ol>",
				"<ul><li>bullet</li></ul>",
				'<ul data-checked="true"><li>done</li></ul>',
				'<ul data-checked="false"><li>todo</li></ul>',
				"<blockquote>quote</blockquote>",
				'<pre class="ql-syntax" spellcheck="false">a &lt; b\n</pre>'
			].join("")
		)
		// What the next load sees: the saved document after the sanitizer, still carrying every format.
		const reloaded = sanitizeRichTextHtml(serializeRichEditor(quill.root))

		for (const fragment of [
			"<h2>Title</h2>",
			"<strong>bold</strong>",
			"<em>it</em>",
			"<u>under</u>",
			'href="https://filen.io"',
			'style="color: rgb(230, 0, 0)',
			'class="ql-align-center"',
			"<ol><li>one</li></ol>",
			"<ul><li>bullet</li></ul>",
			'<ul data-checked="true"><li>done</li></ul>',
			'<ul data-checked="false"><li>todo</li></ul>',
			"<blockquote>quote</blockquote>",
			'<pre class="ql-syntax">a &lt; b\n</pre>'
		]) {
			expect(reloaded).toContain(fragment)
		}
	})
})
