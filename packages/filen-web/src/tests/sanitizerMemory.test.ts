// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

// Every DOMPurify instance the app keeps lets go of what a run removed (it holds that run's parsed document, the
// whole message or note, until the next run).

const { instances } = vi.hoisted(() => ({ instances: [] as { removed: unknown[] }[] }))

vi.mock("dompurify", async () => {
	const actual = await vi.importActual<{ default: (window: Window) => { removed: unknown[] } }>("dompurify")

	return {
		default: Object.assign((window: Window) => {
			const instance = actual.default(window)

			instances.push(instance)

			return instance
		}, actual.default)
	}
})

const { sanitizeEmailHtml } = await import("@/features/preview/lib/emailSanitizer")
const { sanitizeRichTextHtml } = await import("@/features/notes/lib/sanitizeRichText")
const { sanitizeSheetClipboard } = await import("@/features/spreadsheet/clipboard/sheetClipboardSanitizer")
const { sanitizePdfMathML } = await import("@/features/preview/lib/pdfMathSanitizer")

describe("DOMPurify instances", () => {
	it("hold nothing a run removed once it returns", () => {
		sanitizeEmailHtml('<script>1</script><p onclick="1">x</p>', () => null)
		sanitizeRichTextHtml('<script>1</script><p onclick="1">x</p>')
		sanitizeSheetClipboard('<script>1</script><table onclick="1"></table>')
		sanitizePdfMathML('<math><mi id="x" onclick="1">x</mi><script>1</script></math>')

		expect(instances).toHaveLength(4)
		expect(instances.map(instance => instance.removed.length)).toEqual([0, 0, 0, 0])
	})
})
