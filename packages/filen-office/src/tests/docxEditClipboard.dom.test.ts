// @vitest-environment happy-dom
import { TextSelection } from "prosemirror-state"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { docxSchema, freshSlice } from "@filen/office/core/docx/edit"
import { sourceCopies } from "../core/docx/edit/session"
import { docxComments } from "../core/docx/review/comments"
import { EditSink } from "@filen/office/react/docx/editor"
import { safeClipboardHtml } from "../react/docx/edit/sink"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

const DOC = buildDocx({ body: p("Alpha beta gamma") + p("Second paragraph") })
const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
const TABLE_DOC = buildDocx({
	body:
		p("Intro text") +
		'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
		`<w:tr>${cell("One")}${cell("Two")}</w:tr><w:tr>${cell("Three")}${cell("Four")}</w:tr></w:tbl>` +
		p("Outro text")
})

// The top-level paragraphs' text, tabs and breaks as characters.
function paragraphs(editor: PagedEditor): string[] {
	const out: string[] = []

	editor.state.doc.forEach(node => {
		if (node.type.name !== "paragraph") return

		out.push(
			node.textBetween(0, node.content.size, undefined, leaf =>
				leaf.type.name === "tab" ? "\t" : leaf.type.name === "break" ? "\n" : ""
			)
		)
	})

	return out
}

function paragraphStart(editor: PagedEditor, index: number): number {
	let found = -1

	editor.state.doc.forEach((_node, offset, k) => {
		if (k === index) found = offset + 1
	})

	return found
}

function select(sink: EditSink, from: number, to: number): void {
	sink.view.dispatch(sink.view.state.tr.setSelection(TextSelection.create(sink.view.state.doc, from, to)))
}

// Every node and mark type in a document, by name.
function typesOf(editor: PagedEditor): Set<string> {
	const out = new Set<string>()

	editor.state.doc.descendants(node => {
		out.add(node.type.name)

		for (const mark of node.marks) out.add(`mark:${mark.type.name}`)
	})

	return out
}

describe("EditSink clipboard commands", () => {
	let host: HTMLDivElement

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
	})

	afterEach(() => host.remove())

	it("gives the selection as a copy writes it, and nothing for an empty one", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 0)

		expect(sink.clipboardContent()).toBeUndefined()
		select(sink, start, start + 5)

		const content = sink.clipboardContent()

		expect(content?.text).toBe("Alpha")
		expect(content?.html).toContain("Alpha")
		sink.destroy()
	})

	it("cuts and pastes through the editor's parsers, and refuses both read-only", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 0)

		select(sink, start, start + 6)

		const content = sink.clipboardContent()

		expect(sink.deleteSelection()).toBe(true)
		expect(editor.state.doc.child(0).textContent).toBe("beta gamma")
		expect(sink.paste({ text: content?.text ?? "" })).toBe(true)
		expect(editor.state.doc.child(0).textContent).toBe("Alpha beta gamma")

		sink.setReadOnly(true)
		select(sink, start, start + 5)
		expect(sink.deleteSelection()).toBe(false)
		expect(sink.paste({ text: "nope" })).toBe(false)
		expect(editor.state.doc.child(0).textContent).toBe("Alpha beta gamma")
		sink.destroy()
	})

	it("pastes foreign HTML as paragraphs with basic formatting only", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 1)
		const before = typesOf(editor)

		select(sink, start, start)
		expect(
			sink.paste({
				html:
					'<style>@import url("https://example.com/x.css"); p { color: red }</style>' +
					'<p>Safe <b>bold</b> <a href="javascript:alert(1)">link</a><img src="https://example.com/x.png" onerror="alert(1)"></p>' +
					"<script>alert(1)</script><p>End</p>"
			})
		).toBe(true)

		const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n")

		expect(text).toContain("Safe bold link")
		expect(text).toContain("End")
		expect(text).not.toContain("alert")

		// Nothing new but paragraphs, text and basic formatting; no node carries a URL.
		const added = [...typesOf(editor)].filter(type => !before.has(type))

		expect(added.every(type => ["mark:bold", "mark:italic", "mark:underline", "mark:strike", "break"].includes(type))).toBe(true)
		editor.state.doc.descendants(node => {
			expect(JSON.stringify(node.attrs)).not.toMatch(/https?:|javascript:/)

			for (const mark of node.marks) expect(JSON.stringify(mark.attrs)).not.toMatch(/https?:|javascript:/)
		})
		expect(document.querySelector("img, iframe, script[src]")).toBeNull()
		sink.destroy()
	})

	it("keeps only the elements the parser reads, without attributes", () => {
		expect(
			safeClipboardHtml(
				'<meta charset="utf-8"><div data-pm-slice=\'1 1 ["table",{"src":3}]\' style="x"><p class="a" style="background:url(https://e.x/a)">A &amp; <span>b</span>' +
					'<a href="https://e.x">c</a><img src="https://e.x/i.png"><script>x()</script></p><table><tr><td>d</td></tr></table></div>'
			)
		).toBe("<p>A &amp; bc</p><p>d</p>")
		expect(safeClipboardHtml("<b>x</b><br><svg><text>no</text></svg>&lt;tag&gt;")).toBe("<p><b>x</b><br>&lt;tag&gt;</p>")
	})

	it("flattens tables to a paragraph per row, never leaving a cell for the clipboard reader to wrap", () => {
		expect(safeClipboardHtml("<p>A</p><table><tr><td>B</td><td><p>C</p><p>D</p></td></tr><tr><th>E</th></tr></table><p>F</p>")).toBe(
			"<p>A</p><p>B<span data-fo-tab></span>C<br>D</p><p>E</p><p>F</p>"
		)
		// A leading cell (ProseMirror's reader would wrap the whole paste in a table and keep only the row).
		expect(safeClipboardHtml("<td>X</td><p>Y</p>")).toBe("<p>X</p><p>Y</p>")
		expect(safeClipboardHtml("<table><tr><td><table><tr><td>in</td><td>ner</td></tr></table></td><td>out</td></tr></table>")).toBe(
			"<p>in<span data-fo-tab></span>ner<span data-fo-tab></span>out</p>"
		)
		expect(safeClipboardHtml("<p>x</p>\n\n<p>&nbsp;</p><div><br></div><p>y<br></p>")).toBe("<p>x</p><p></p><p></p><p>y</p>")
	})

	it("keeps formatting by element and by inline style, and Word's tabs", () => {
		expect(
			safeClipboardHtml(
				'<b style="font-weight:normal"><span style="font-weight:700">B</span><span style="font-style:italic;text-decoration:underline line-through">I</span></b>'
			)
		).toBe("<p><b>B</b><i><u><s>I</s></u></i></p>")
		expect(safeClipboardHtml("<p>a<span style='mso-tab-count:2'>&nbsp; </span>b</p>")).toBe(
			"<p>a<span data-fo-tab></span><span data-fo-tab></span>b</p>"
		)
		expect(safeClipboardHtml("<pre>a  b</pre>")).toBe("<pre>a  b</pre>")
		expect(safeClipboardHtml("<pre>line1\nline2\n\tindented\n</pre>")).toBe(
			"<pre>line1</pre><pre>line2</pre><pre><span data-fo-tab></span>indented</pre>"
		)
	})

	// A paste opens into the paragraph at the caret: its last paragraph ends with the text after the caret.
	it("pastes paragraphs around a table, the table as a paragraph per row", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 1)

		select(sink, start, start)
		expect(sink.paste({ html: "<p>AAA</p><table><tbody><tr><td>CCC</td><td>DDD</td></tr></tbody></table><p>BBB</p>" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["Alpha beta gamma", "AAA", "CCC\tDDD", "BBBSecond paragraph"])
		sink.destroy()
	})

	it("pastes preformatted text line by line, keeping its spaces and tabs", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

		select(sink, paragraphStart(editor, 1), paragraphStart(editor, 1))
		expect(sink.paste({ html: "<pre>line1\nline2  two\n\tindented\n</pre>" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["Alpha beta gamma", "line1", "line2  two", "\tindentedSecond paragraph"])
		sink.destroy()
	})

	it("pastes Word's HTML", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 1)

		select(sink, start, start)
		expect(
			sink.paste({
				html:
					'<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset=utf-8><style>p.MsoNormal{margin:0}</style></head>' +
					"<body lang=EN-US><!--StartFragment--><div class=WordSection1><p class=MsoNormal><span>AAA <b>intro</b></span></p>\n" +
					"<table class=MsoTableGrid border=1><tr><td><p class=MsoNormal><span>CCC cell</span></p></td>\n<td><p class=MsoNormal><b>DDD cell</b></p></td></tr></table>\n" +
					"<p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>BBB<span style='mso-tab-count:1'>&nbsp;&nbsp; </span>after</p></div><!--EndFragment--></body></html>"
			})
		).toBe(true)
		expect(paragraphs(editor)).toEqual(["Alpha beta gamma", "AAA intro", "CCC cell\tDDD cell", "", "BBB\tafterSecond paragraph"])

		let bold = ""

		editor.state.doc.descendants(node => {
			if (node.isText && node.marks.some(mark => mark.type.name === "bold")) bold += `${node.text ?? ""}|`
		})
		expect(bold).toBe("intro|DDD cell|")
		sink.destroy()
	})

	it("pastes Google Docs' HTML without making everything bold", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 1)

		select(sink, start, start)
		expect(
			sink.paste({
				html:
					'<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">AAA intro</span></p>' +
					'<div dir="ltr"><table><colgroup><col width="100"></colgroup><tbody><tr><td><p dir="ltr"><span style="font-weight:700">CCC</span></p></td>' +
					'<td><p dir="ltr"><span style="font-style:italic">DDD</span></p></td></tr></tbody></table></div><p dir="ltr"><span>BBB after</span></p></b>'
			})
		).toBe(true)
		expect(paragraphs(editor)).toEqual(["Alpha beta gamma", "AAA intro", "CCC\tDDD", "BBB afterSecond paragraph"])

		const marked: string[] = []

		editor.state.doc.descendants(node => {
			const names = node.marks.map(mark => mark.type.name).filter(name => name !== "run")

			if (node.isText && names.length > 0) marked.push(`${node.text ?? ""}:${names.join(",")}`)
		})
		expect(marked).toEqual(["CCC:bold", "DDD:italic"])
		sink.destroy()
	})

	it("copies a paragraph and a table and pastes them back as text in paragraphs", async () => {
		const { editor } = await pagedEditor(TABLE_DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const doc = editor.state.doc
		const intro = paragraphStart(editor, 0)
		let lastCellEnd = -1

		doc.descendants((node, pos) => {
			if (node.type.name === "paragraph" && node.textContent === "Four") lastCellEnd = pos + 1 + node.content.size
		})
		select(sink, intro + 6, lastCellEnd)

		const content = sink.clipboardContent()

		expect(content?.text).toBe("text\nOne\tTwo\nThree\tFour")

		const outro = paragraphStart(editor, 2)

		select(sink, outro, outro)
		expect(sink.paste({ html: content?.html ?? "" })).toBe(true)
		expect(paragraphs(editor)).toEqual(["Intro text", "text", "One\tTwo", "Three\tFourOutro text"])
		sink.destroy()
	})

	it("selects all", async () => {
		const { editor } = await pagedEditor(DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

		expect(sink.selectAll()).toBe(true)
		expect(editor.selection().from).toBe(0)
		expect(editor.selection().to).toBe(editor.state.doc.content.size)
		sink.destroy()
	})
})

// A Wingdings check mark (F0FC, U+2713 as shown) inserted with Insert > Symbol, and a Wingdings pencil (F021, U+1F589,
// a surrogate pair) under a comment.
const SYMBOL_DOC = buildDocx({
	body:
		'<w:p><w:r><w:t xml:space="preserve">Done </w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>' +
		'<w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>' +
		'<w:p><w:r><w:t xml:space="preserve">Write </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:sym w:font="Wingdings" w:char="F021"/></w:r>' +
		'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>' +
		p("Third paragraph"),
	comments: '<w:comment w:id="0" w:author="Bo"><w:p><w:r><w:t>Pencil</w:t></w:r></w:p></w:comment>'
})

function symbols(editor: PagedEditor): { char: unknown; font: unknown }[] {
	const out: { char: unknown; font: unknown }[] = []

	editor.state.doc.descendants(node => {
		if (node.type.name === "symbol") out.push({ char: node.attrs["char"], font: node.attrs["font"] })

		return true
	})

	return out
}

describe("EditSink clipboard of symbol-font characters", () => {
	let host: HTMLDivElement

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
	})

	afterEach(() => host.remove())

	it("copies a symbol as the character it shows, reads it so, and pastes the HTML back as the symbol", async () => {
		const { editor } = await pagedEditor(SYMBOL_DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const start = paragraphStart(editor, 0)

		select(sink, start, start + "Done ✓ end".length)

		const content = sink.clipboardContent()
		const shown = document.createElement("div")

		shown.innerHTML = content?.html ?? ""
		expect(content?.text).toBe("Done \u2713 end")
		expect(shown.textContent).toContain("Done \u2713 end")
		expect(shown.textContent).not.toContain("\uf0fc")
		// What assistive technology reads in the sink.
		expect(sink.view.dom.textContent).toContain("Done \u2713 end")
		expect(sink.view.dom.textContent).not.toContain("\uf0fc")

		const third = paragraphStart(editor, 2)

		select(sink, third, third)
		expect(sink.paste({ html: content?.html ?? "" })).toBe(true)
		expect(symbols(editor)).toEqual([
			{ char: 0xf0fc, font: "Wingdings" },
			{ char: 0xf021, font: "Wingdings" },
			{ char: 0xf0fc, font: "Wingdings" }
		])
		expect(paragraphs(editor)[2]).toBe("Done  endThird paragraph")
		sink.destroy()
	})

	it("keeps a pasted symbol's code and font as attribute values only", () => {
		expect(safeClipboardHtml('<span data-fo-sym="61692" data-fo-sym-font="W&quot;><img src=x>">x</span>')).toBe(
			'<p><span data-fo-sym="61692" data-fo-sym-font="W&quot;&gt;&lt;img src=x&gt;"></span></p>'
		)
		expect(safeClipboardHtml('<span data-fo-sym="99999999">x</span>')).toBe("<p>x</p>")
	})

	it("moves a comment on a symbol a cut takes when its text is pasted back", async () => {
		const { editor } = await pagedEditor(SYMBOL_DOC)
		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
		const store = docxComments(editor)
		const second = paragraphStart(editor, 1)
		const end = second + editor.state.doc.child(1).content.size

		select(sink, second, end)

		const content = sink.clipboardContent()

		expect(content?.text).toBe("Write \u{1f589} here")
		expect(sink.deleteSelection()).toBe(true)
		expect(store.threads()).toEqual([])

		const third = paragraphStart(editor, 2)

		select(sink, third, third)
		expect(sink.paste({ text: content?.text ?? "" })).toBe(true)
		expect(store.threads().map(thread => thread.id)).toEqual(["0"])
		sink.destroy()
	})
})

describe("EditSink paste of note references and Delete before a section break", () => {
	let host: HTMLDivElement

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
	})

	afterEach(() => host.remove())

	const SEPARATORS =
		'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
		'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
	const NOTE_BODY = '<w:p><w:r><w:t>One</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' + p("Two")
	const noteRefs = (editor: PagedEditor): number => {
		let count = 0

		editor.state.doc.descendants(node => {
			if (node.type === docxSchema.nodes.note_ref) count++

			return !node.isInline
		})

		return count
	}

	// The first paragraph (its note reference) pasted at the end, through the sink's view as a paste lands there.
	const pasteFirst = (editor: PagedEditor, sink: EditSink): void => {
		const doc = sink.view.state.doc
		const context = editor.body.session.context
		const part = editor.body.session.story.part.index
		const slice = freshSlice(doc.slice(1, doc.child(0).nodeSize - 1), sourceCopies(context), part, part, true)
		const at = doc.content.size - 1

		sink.view.dispatch(sink.view.state.tr.replaceRange(at, at, slice).setMeta("uiEvent", "paste"))
	}

	it("pastes a note reference as a copy of its note, and refuses one whose note cannot be copied whole", async () => {
		const whole =
			'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note</w:t></w:r></w:p></w:footnote>'
		const locked =
			'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note</w:t></w:r></w:p>' +
			'<w:sdt><w:sdtPr><w:id w:val="5"/><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Locked</w:t></w:r></w:p></w:sdtContent></w:sdt></w:footnote>'

		for (const note of [whole, locked]) {
			const { editor } = await pagedEditor(buildDocx({ body: NOTE_BODY, footnotes: SEPARATORS + note }))
			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
			const before = editor.state.doc

			pasteFirst(editor, sink)

			if (note === whole) expect(noteRefs(editor)).toBe(2)
			else expect(editor.state.doc).toBe(before)

			sink.destroy()
			editor.dispose()
		}
	})

	it("deletes the section break with Delete at the end of the paragraph ending a section", async () => {
		const page =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'

		for (const tracked of [false, true]) {
			const { editor, context } = await pagedEditor(
				buildDocx({
					body:
						p("One") +
						`<w:p><w:pPr><w:sectPr>${page}</w:sectPr></w:pPr><w:r><w:t>Breaker</w:t></w:r></w:p>` +
						p("Two") +
						`<w:sectPr>${page}</w:sectPr>`
				})
			)
			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
			const end = paragraphStart(editor, 1) + "Breaker".length

			context.identity.author = "T"
			context.review.tracking = tracked
			select(sink, end, end)
			sink.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }))
			await editor.whenSettled()

			const breaks = (): number => {
				let count = 0

				editor.state.doc.forEach(node => {
					if (node.attrs["sectPr"] !== -1) count++
				})

				return count
			}

			// Untracked the paragraphs join and the break goes; tracked its paragraph mark is recorded as deleted.
			if (tracked) expect(editor.state.doc.child(1).attrs["revision"]).not.toBe(0)
			else {
				expect(breaks()).toBe(0)
				expect(paragraphs(editor)).toEqual(["One", "BreakerTwo"])
			}

			sink.destroy()
			editor.dispose()
		}
	})
	it("deletes the section break with Backspace at the start of the paragraph after it", async () => {
		const page =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'

		for (const tracked of [false, true]) {
			const { editor, context } = await pagedEditor(
				buildDocx({
					body:
						p("One") +
						`<w:p><w:pPr><w:sectPr>${page}</w:sectPr></w:pPr><w:r><w:t>Breaker</w:t></w:r></w:p>` +
						p("Two") +
						`<w:sectPr>${page}</w:sectPr>`
				})
			)
			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })
			const end = paragraphStart(editor, 2)

			context.identity.author = "T"
			context.review.tracking = tracked
			select(sink, end, end)
			sink.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }))
			await editor.whenSettled()

			const breaks = (): number => {
				let count = 0

				editor.state.doc.forEach(node => {
					if (node.attrs["sectPr"] !== -1) count++
				})

				return count
			}

			// Untracked the paragraphs join and the break goes; tracked its paragraph mark is recorded as deleted.
			if (tracked) expect(editor.state.doc.child(1).attrs["revision"]).not.toBe(0)
			else {
				expect(breaks()).toBe(0)
				expect(paragraphs(editor)).toEqual(["One", "BreakerTwo"])
			}

			sink.destroy()
			editor.dispose()
		}
	})
})
