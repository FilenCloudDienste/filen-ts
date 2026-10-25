// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { useRef } from "react"
import { render } from "@testing-library/react"
import type { SheetCommand } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { MAX_PASTE_HTML, sanitizeSheetClipboard } from "@/features/spreadsheet/clipboard/sheetClipboardSanitizer"
import { useSheetClipboard } from "@/features/spreadsheet/clipboard/useSheetClipboard"

// The sheet clipboard on the web: HTML goes through the shared sheet clipboard sanitizer both ways, a copy puts text
// and HTML on the clipboard (text alone past the HTML size), and a paste hands the session sanitised HTML beside the
// text, or the text alone when the HTML is too large to read.

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("the sheet clipboard sanitizer", () => {
	it("keeps tables, their style rules and the attributes spreadsheets read, and drops scripts and handlers", () => {
		const clean = sanitizeSheetClipboard(
			'<html><head><style>.xl65{mso-number-format:"0\\.00"}</style><script>alert(1)</script></head><body>' +
				'<google-sheets-html-origin><table><tr><td class="xl65" x:num="1.5" sdval="1.5" sdnum="1033;0;0.00" ' +
				'data-sheets-value="{&quot;1&quot;:3}" data-sheets-formula="=R[0]C[-1]" onclick="alert(2)">1.50' +
				'<img src="x" onerror="alert(3)"><iframe src="https://example.com"></iframe></td></tr></table>' +
				"</google-sheets-html-origin></body></html>"
		)

		expect(clean).toContain('.xl65{mso-number-format:"0\\.00"}')
		expect(clean).toContain('class="xl65"')
		expect(clean).toContain('x:num="1.5"')
		expect(clean).toContain('sdval="1.5"')
		expect(clean).toContain('sdnum="1033;0;0.00"')
		expect(clean).toContain("data-sheets-value=")
		expect(clean).toContain('data-sheets-formula="=R[0]C[-1]"')
		expect(clean).not.toMatch(/script|onclick|onerror|<img|<iframe|alert/)
	})

	it("keeps Excel's cell formats, which it writes inside an HTML comment in its style element", () => {
		const clean = sanitizeSheetClipboard(
			'<html><head><style><!--table\n\t{mso-displayed-decimal-separator:"\\.";}\n.xl65\n\t{font-weight:700;\n\tbackground:yellow;}\n--></style></head>' +
				'<body><table><tr><td class="xl65">Bold</td></tr></table></body></html>'
		)

		expect(clean).toContain(".xl65")
		expect(clean).toContain("font-weight:700")
		expect(clean).toContain('<td class="xl65">Bold</td>')
	})
})

interface Harness {
	readonly commands: SheetCommand[]
	readonly queries: string[]
}

function Mount({ model }: { model: SheetGridModel }) {
	const ref = useRef<HTMLDivElement>(null)

	useSheetClipboard({ model, container: ref, canEdit: true, onRefused: () => undefined })

	return (
		<div ref={ref}>
			<div
				role="grid"
				tabIndex={0}
			/>
		</div>
	)
}

function mount(range: { startRow: number; startCol: number; endRow: number; endCol: number }, chartsheet = false): Harness {
	const harness: Harness = { commands: [], queries: [] }
	const model = {
		getSnapshot: () => ({ sheet: 0, selection: { ranges: [range] } }),
		cellless: () => chartsheet,
		intent: () => Promise.resolve(),
		command: (command: SheetCommand) => {
			harness.commands.push(command)

			return Promise.resolve({ ok: true })
		},
		session: {
			query: (name: string) => {
				harness.queries.push(name)

				return Promise.resolve(
					name === "copy" ? { clip: 7, text: "a\tb" } : { html: '<table><tr><td onclick="x()">a</td><td>b</td></tr></table>' }
				)
			}
		}
	} as unknown as SheetGridModel

	render(<Mount model={model} />)
	document.querySelector<HTMLElement>("[role=grid]")?.focus()

	return harness
}

function clipboardEvent(type: string, data: Record<string, string>): Event {
	const event = new Event(type, { bubbles: true, cancelable: true })

	Object.defineProperty(event, "clipboardData", { value: { getData: (kind: string) => data[kind] ?? "" } })

	return event
}

describe("useSheetClipboard", () => {
	it("copies text and sanitised HTML, and HTML only for ranges small enough", async () => {
		const items: Record<string, Promise<Blob>>[] = []

		vi.stubGlobal(
			"ClipboardItem",
			class {
				readonly entries: Record<string, Promise<Blob>>

				constructor(entries: Record<string, Promise<Blob>>) {
					this.entries = entries
					items.push(entries)
				}
			}
		)
		vi.stubGlobal("navigator", { clipboard: { write: vi.fn(() => Promise.resolve()), writeText: vi.fn(() => Promise.resolve()) } })

		const small = mount({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 })

		document.dispatchEvent(clipboardEvent("copy", {}))

		expect(Object.keys(items[0] ?? {})).toEqual(["text/plain", "text/html"])
		expect(await (await items[0]?.["text/plain"])?.text()).toBe("a\tb")

		const html = await (await items[0]?.["text/html"])?.text()

		expect(html).toContain("<td>a</td>")
		expect(html).not.toContain("onclick")
		expect(small.queries).toEqual(["copy", "copyHtml"])

		document.body.innerHTML = ""

		const large = mount({ startRow: 0, startCol: 0, endRow: 99_999, endCol: 0 })

		document.dispatchEvent(clipboardEvent("copy", {}))

		expect(Object.keys(items[1] ?? {})).toEqual(["text/plain"])
		expect(large.queries).toEqual(["copy"])
	})

	it("pastes sanitised HTML beside the text, and the text alone when the HTML is too large", async () => {
		const harness = mount({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 })

		document.dispatchEvent(
			clipboardEvent("paste", { "text/plain": "x", "text/html": "<table><tr><td>x<script>1</script></td></tr></table>" })
		)
		document.dispatchEvent(
			clipboardEvent("paste", {
				"text/plain": "y",
				"text/html": `<table>${"<tr><td>y</td></tr>".repeat(MAX_PASTE_HTML / 10)}</table>`
			})
		)
		document.dispatchEvent(clipboardEvent("paste", { "text/plain": "z" }))
		await Promise.resolve()

		expect(harness.commands.map(command => command.type)).toEqual(["clipboard.pasteHtml", "clipboard.paste", "clipboard.paste"])

		const first = harness.commands[0]

		expect(first?.type === "clipboard.pasteHtml" ? first.html : "").not.toContain("script")
		expect(first).toMatchObject({ sheet: 0, at: { row: 2, col: 1 }, text: "x" })
	})

	it("copies and pastes nothing on a chartsheet, which has no cells", async () => {
		vi.stubGlobal("navigator", { clipboard: { write: vi.fn(() => Promise.resolve()), writeText: vi.fn(() => Promise.resolve()) } })

		const harness = mount({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, true)

		document.dispatchEvent(clipboardEvent("copy", {}))
		document.dispatchEvent(clipboardEvent("paste", { "text/plain": "x" }))
		await Promise.resolve()

		expect(harness.queries).toEqual([])
		expect(harness.commands).toEqual([])
	})
})
