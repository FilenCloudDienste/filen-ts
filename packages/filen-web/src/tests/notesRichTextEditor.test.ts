// @vitest-environment jsdom
//
// jsdom (per-file pragma, same as notesSanitizeRichText.test.ts): seedRichEditor routes through
// DOMPurify, which is a passthrough without a real `document`. The rest of the suite stays on node.

import { describe, expect, it, vi } from "vitest"
import {
	shouldPropagateRichChange,
	seedRichEditor,
	applyRichReadOnly,
	reflectRichFormats,
	nextHeaderValue,
	nextListValue,
	nextToggleValue,
	cycleHeaderValue,
	EMPTY_RICH_FORMATS
} from "@/features/notes/components/editor/richTextEditor.logic"

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

describe("toolbar format-value helpers", () => {
	it("nextToggleValue negates", () => {
		expect(nextToggleValue(false)).toBe(true)
		expect(nextToggleValue(true)).toBe(false)
	})

	it("nextHeaderValue toggles a level off when active, else switches to it", () => {
		expect(nextHeaderValue(2, 2)).toBe(false)
		expect(nextHeaderValue(1, 2)).toBe(2)
		expect(nextHeaderValue(null, 3)).toBe(3)
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
