// @vitest-environment happy-dom
import { AllSelection } from "prosemirror-state"
import { afterEach, describe, expect, it } from "vitest"
import { RevisionView } from "../core/docx/model/kinds"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxSessionApi } from "@filen/office/dom/docx"
import { DocxMediaCache, type DocxDocument } from "@filen/office/react/docx"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { LineFlag } from "../core/text/index"
import { paintPage, patchPage } from "../react/docx/paint/page"
import { FIXTURE_TABLES, fixturePage, text, type FixtureLine } from "./docxPageFixture"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedDomFixtures"

// A copy writes what the revision view shows: No Markup (Final) leaves deleted text out, Original inserted
// text; Markup copies the tracked changes as they are. A cut takes what it copied.

const SESSION: DocxSessionApi = {
	objects: () => Promise.resolve([]),
	media: () => Promise.resolve(null),
	locate: () => Promise.resolve(null),
	find: () => Promise.resolve(new Int32Array(0)),
	annotations: () => Promise.resolve(null),
	close: () => undefined
}

const DOCUMENT: DocxDocument = {
	status: "ready",
	info: undefined,
	pages: [],
	pageCount: 0,
	tables: { styles: [], decorations: [], links: [] },
	session: SESSION,
	media: new DocxMediaCache(SESSION, undefined, { create: () => "blob:picture", revoke: () => undefined }),
	error: undefined
}

const BY = 'w:author="Ann" w:date="2024-01-01T00:00:00Z"'
const DOC = buildDocx({
	body:
		`<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" ${BY}><w:r><w:t xml:space="preserve">added </w:t></w:r></w:ins>` +
		`<w:del w:id="2" ${BY}><w:r><w:delText xml:space="preserve">removed </w:delText></w:r></w:del><w:r><w:t>end</w:t></w:r></w:p>` +
		p("Second")
})

const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
// A paragraph whose mark is deleted (it runs on into the next one in Final) and a table's deleted row.
const BLOCKS = buildDocx({
	body:
		`<w:p><w:pPr><w:rPr><w:del w:id="3" ${BY}/></w:rPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>` +
		p("Two") +
		'<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
		`<w:tr>${cell("Alpha")}${cell("Beta")}</w:tr>` +
		`<w:tr><w:trPr><w:del w:id="4" ${BY}/></w:trPr>${cell("Gamma")}${cell("Delta")}</w:tr>` +
		"</w:tbl>" +
		p("End")
})

interface Copier {
	clipboardContent(): { readonly html: string; readonly text: string } | undefined
	deleteSelection(): boolean
}

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const SURFACES: readonly { readonly name: string; open(editor: PagedEditor): Copier }[] = [
	{
		name: "the pages' input view",
		open(editor) {
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

			cleanups.push(() => {
				sink.destroy()
				host.remove()
			})

			return sink
		}
	},
	{
		name: "Mobile view",
		open(editor) {
			const scroller = document.createElement("div")

			document.body.appendChild(scroller)

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: false,
				apple: false,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: DOCUMENT
			})

			cleanups.push(() => {
				reflow.destroy()
				scroller.remove()
			})

			return reflow
		}
	}
]

for (const surface of SURFACES) {
	describe(`Copy in ${surface.name}`, () => {
		it("writes the text and HTML the revision view shows", async () => {
			const { editor } = await pagedEditor(DOC)
			const copier = surface.open(editor)
			const session = editor.body.session

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

			const copied = (view: RevisionView): { html: string; text: string } => {
				editor.setView(view)

				const content = copier.clipboardContent()

				if (content === undefined) throw new Error("nothing copied")

				return { html: content.html, text: content.text }
			}

			const markup = copied(RevisionView.Markup)

			expect(markup.text).toBe("Kept added removed end\nSecond")
			expect(markup.html).toContain("removed")

			const final = copied(RevisionView.Final)

			expect(final.text).toBe("Kept added end\nSecond")
			expect(final.html).toContain("added")
			expect(final.html).not.toContain("removed")

			const original = copied(RevisionView.Original)

			expect(original.text).toBe("Kept removed end\nSecond")
			expect(original.html).not.toContain("added")
			expect(original.html).toContain("removed")
		})

		it("leaves out the rows a view hides and runs a paragraph on where the view hides its mark", async () => {
			const { editor } = await pagedEditor(BLOCKS)
			const copier = surface.open(editor)
			const session = editor.body.session

			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

			const copied = (view: RevisionView): { html: string; text: string } => {
				editor.setView(view)

				const content = copier.clipboardContent()

				if (content === undefined) throw new Error("nothing copied")

				return { html: content.html, text: content.text }
			}
			const paragraphs = (html: string): number => html.split("<p").length - 1
			const markup = copied(RevisionView.Markup)

			expect(markup.text).toBe("One\nTwo\nAlpha\tBeta\nGamma\tDelta\nEnd")
			expect(markup.html).toContain("Gamma")

			const final = copied(RevisionView.Final)

			expect(final.text).toBe("OneTwo\nAlpha\tBeta\nEnd")
			expect(final.html).not.toContain("Gamma")
			expect(final.html).toContain("Alpha")
			expect(paragraphs(final.html)).toBe(paragraphs(markup.html) - 3)
			expect(copied(RevisionView.Original).text).toBe(markup.text)
		})

		it("cuts what it copies: the text shown goes, tracked deletions stay tracked", async () => {
			const { editor } = await pagedEditor(DOC)
			const copier = surface.open(editor)
			const session = editor.body.session

			session.context.review.tracking = true
			session.context.identity.author = "Bo"
			editor.setView(RevisionView.Final)
			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
			expect(copier.clipboardContent()?.text).toBe("Kept added end\nSecond")
			expect(copier.deleteSelection()).toBe(true)

			// Tracked: everything stays in the document, Ann's deletion as it was, the rest deleted by Bo, Ann's
			// insertion... deleted by Bo too (a tracked deletion of someone else's insertion).
			const deleted: string[] = []

			session.state.doc.descendants(node => {
				const mark = node.marks.find(entry => entry.type.name === "deletion")

				if (node.isText && mark !== undefined) deleted.push(`${String(mark.attrs["author"])}:${node.text ?? ""}`)

				return true
			})
			expect(deleted).toContain("Ann:removed ")
			expect(deleted.some(entry => entry.startsWith("Bo:"))).toBe(true)
		})
	})
}

describe("what copying puts after a painted line", () => {
	// Per line: a run of spaces to the next line, a newline, a single space, nothing after a hyphen, a space where
	// the next line follows at once.
	const page = (top: number) => {
		const line = (at: number, source: number, start: number, end: number, flags: number): FixtureLine => ({
			top: top + at * 30,
			source,
			start,
			end,
			flags,
			fragments: [text(start, end)]
		})

		return fixturePage({
			sources: ["one   two", "ab cd", "hy-phen", "abcd"],
			lines: [
				line(0, 0, 0, 3, LineFlag.FIRST),
				line(1, 0, 6, 9, LineFlag.LAST),
				line(2, 1, 0, 2, LineFlag.FIRST),
				line(3, 1, 3, 5, LineFlag.LAST),
				line(4, 2, 0, 3, LineFlag.FIRST | LineFlag.HYPHENATED),
				line(5, 2, 3, 7, LineFlag.LAST),
				line(6, 3, 0, 2, LineFlag.FIRST),
				line(7, 3, 2, 4, LineFlag.LAST)
			]
		})
	}
	const separators = (lines: readonly { readonly text: HTMLElement }[]): (string | undefined)[] =>
		lines.map(line => line.text.querySelector(".fo-docx-eol")?.textContent)

	it("is the same on a patched page as on a fresh one, for every kind of separator", () => {
		const fresh = paintPage(page(100), { document, tables: FIXTURE_TABLES })

		expect(separators(fresh.lines)).toEqual(["   ", "\n", " ", "\n", undefined, "\n", " ", "\n"])

		// Painted elsewhere, then moved: every line kept.
		const moved = patchPage(paintPage(page(140), { document, tables: FIXTURE_TABLES }), page(100), { document, tables: FIXTURE_TABLES })

		expect(separators(moved.painted.lines)).toEqual(separators(fresh.lines))
		expect(moved.painted.root.innerHTML).toBe(fresh.root.innerHTML)
	})
})
