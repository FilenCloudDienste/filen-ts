import type { Node as ProseMirrorNode } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { docxSchema, type DocxEditContext } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import type { DocxPackage } from "@filen/office/core/docx"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { sessionBookmarks } from "../core/docx/fields/bookmarks"
import { parseFieldCode } from "../core/docx/fields/evaluate"
import { tocOptions, tocRegions } from "../core/docx/fields/toc"
import { isDeleted, markable } from "../core/docx/review/track"
import { STYLES_PART } from "./docxEditFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor, savedDigest, pageDigest, settleAll } from "./pagedFixtures"

const decoder = new TextDecoder()

const nodes = docxSchema.nodes

const STYLES = STYLES_PART(
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr></w:style>' +
		'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
)

const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

function heading(level: number, text: string): string {
	return p(text, `<w:pStyle w:val="Heading${String(level)}"/>`)
}

function spec(body: string): SyntheticDocx {
	return { body, parts: [STYLES], relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }] }
}

const HEADINGS =
	p("Contents") +
	heading(1, "Introduction") +
	p("Text one.") +
	pageBreak +
	heading(2, "Background") +
	p("Text two.") +
	heading(4, "Too deep") +
	pageBreak +
	heading(1, "Results") +
	p("Text three.")

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

async function open(source: SyntheticDocx | Uint8Array): Promise<Opened> {
	const opened = await pagedEditor(source instanceof Uint8Array ? source : buildDocx(source))

	await settleAll(opened.editor)

	return opened
}

async function save(opened: Opened): Promise<Uint8Array> {
	return (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array
}

async function read(bytes: Uint8Array, name: string): Promise<string> {
	const pkg = await OpcPackage.open(bytesSource(bytes))

	return decoder.decode(await pkg.read(name))
}

function caretAt(editor: PagedEditor, pos: number): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

// Where the text `text` starts in the body.
function find(doc: ProseMirrorNode, text: string): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.isText && (node.text ?? "").includes(text)) found = pos + (node.text ?? "").indexOf(text)

		return true
	})

	return found
}

// The entries of the table of contents: text and page number, by paragraph.
function entries(doc: ProseMirrorNode, from: number, to: number): string[] {
	const out: string[] = []

	doc.nodesBetween(from, to, node => {
		if (node.type !== nodes.paragraph) return true

		let line = ""

		node.forEach(child => {
			if (child.isText) line += child.text ?? ""
			else if (child.type === nodes.tab) line += "\t"
			else if (child.type === nodes.field) line += `[${child.attrs["result"] as string}]`
		})

		out.push(line)

		return false
	})

	return out
}

describe("tables of contents", () => {
	it("bookmarks a heading in a content control showing its placeholder, the placeholder kept", async () => {
		const control = (text: string): string =>
			`<w:sdt><w:sdtPr><w:id w:val="7"/><w:temporary/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>${heading(1, text)}</w:sdtContent></w:sdt>`
		const opened = await open(spec(p("Contents") + control("[Heading]") + p("Text.")))
		const editor = opened.editor

		caretAt(editor, find(editor.session.state.doc, "Contents"))
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const document = await read(await save(opened), "word/document.xml")

		expect(document).toMatch(
			/<w:showingPlcHdr\/>.*<w:bookmarkStart w:id="\d+" w:name="_Toc\d+"\/>.*\[Heading\].*<w:bookmarkEnd w:id="\d+"\/>/
		)
	})

	it("inserts Word's default table from the headings, with links, bookmarks and page numbers", async () => {
		const opened = await open(spec(HEADINGS))
		const editor = opened.editor

		caretAt(editor, find(editor.session.state.doc, "Introduction"))

		expect(editor.canExecute("toc.insert")).toBe(true)
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const session = editor.session
		const [region] = tocRegions(session)

		expect(region).toBeDefined()
		expect(region?.source).toBe(false)
		// The table took a page of its own: every heading moved on by one.
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual([
			"Introduction\t[1]",
			"Background\t[2]",
			"Results\t[3]"
		])

		const bookmarks = sessionBookmarks(session).list.filter(bookmark => bookmark.name.startsWith("_Toc"))

		expect(bookmarks).toHaveLength(3)

		const bytes = await save(opened)
		const xml = await read(bytes, "word/document.xml")

		expect(xml).toContain(
			'<w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>'
		)
		expect(xml).toContain(`<w:hyperlink w:anchor="${bookmarks[0]?.name ?? ""}" w:history="1">`)
		expect(xml).toMatch(/<w:bookmarkStart w:id="\d+" w:name="_Toc\d{9}"\/>/)
		// Word's runs: entry text not proofed; the tab and page number (every run of its field) hidden in Web
		// layout too, as \z asks.
		expect(xml.match(/<w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><w:noProof\/><\/w:rPr><w:t>/g)).toHaveLength(3)
		expect(xml.match(/<w:r><w:rPr><w:noProof\/><w:webHidden\/><\/w:rPr><w:tab\/>/g)).toHaveLength(3)
		expect(xml.match(/<w:r><w:rPr><w:noProof\/><w:webHidden\/><\/w:rPr><w:(fldChar|instrText|t)\b/g)).toHaveLength(15)

		// Reopened, the table is the file's: paragraphs whose field characters keep their items.
		const reopened = await open(bytes)
		const regions = tocRegions(reopened.editor.session)

		expect(regions).toHaveLength(1)
		expect(regions[0]?.source).toBe(false)
		expect(regions[0]?.updatable).toBe(true)
		expect(reopened.editor.session.state.doc.nodeAt((regions[0]?.from ?? 0) + 1)?.attrs["src"]).toBeGreaterThan(0)
		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("undoes an insertion with its page numbers in one step", async () => {
		const opened = await open(spec(HEADINGS))
		const editor = opened.editor
		const before = editor.session.state.doc

		caretAt(editor, 1)
		await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })
		await settleAll(editor)

		expect(editor.session.state.doc.eq(before)).toBe(false)
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(editor.session.state.doc.eq(before)).toBe(true)
	})

	it("rebuilds the file's table from the headings as they are now, keeping its bookmarks and entry properties", async () => {
		const entry = (name: string, text: string, page: string): string =>
			'<w:p><w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>' +
			`<w:hyperlink w:anchor="${name}" w:history="1"><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/></w:r>` +
			`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF ${name} \\h </w:instrText></w:r>` +
			`<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${page}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>`
		const body =
			'<w:p><w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>' +
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
			entry("_Toc100000001", "Introduction", "7").slice(entry("", "", "").indexOf("<w:hyperlink")) +
			"</w:p>" +
			entry("_Toc100000002", "Results", "9") +
			'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc100000001"/><w:r><w:t>Introduction</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
			p("Text.") +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="2" w:name="_Toc100000002"/><w:r><w:t>Results</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>'
		const opened = await open(spec(body))
		const editor = opened.editor
		const session = editor.session
		const [before] = tocRegions(session)

		expect(before?.source).toBe(false)
		expect(before?.updatable).toBe(true)

		// A heading added between the two.
		const at = find(session.state.doc, "Text.")

		session.dispatch(session.state.tr.insert(at + 5, nodes.paragraph.create({ styleId: "Heading2" }, docxSchema.text("Method"))))
		caretAt(editor, 1)
		expect(editor.canExecute("toc.update")).toBe(true)
		expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
		await settleAll(editor)

		const [region] = tocRegions(session)

		expect(region?.source).toBe(false)
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual(["Introduction\t[2]", "Method\t[2]", "Results\t[2]"])

		const names = sessionBookmarks(session)
			.list.filter(bookmark => bookmark.name.startsWith("_Toc"))
			.map(bookmark => bookmark.name)

		// The headings' bookmarks are reused; the new heading gets one.
		expect(names).toHaveLength(3)
		expect(names[0]).toBe("_Toc100000001")
		expect(names[2]).toBe("_Toc100000002")

		const bytes = await save(opened)
		const xml = await read(bytes, "word/document.xml")

		// The level 1 entries keep the table's own paragraph properties (its right tab with dots); the level 2 entry
		// (no entry of its level to copy, its style without a right tab) gets Word's direct right tab at the margin.
		expect(xml.match(/<w:tab w:val="right" w:leader="dot" w:pos="9350"\/>/g)).toHaveLength(3)
		expect(xml).toContain(`<w:hyperlink w:anchor="${names[1] ?? ""}" w:history="1">`)

		const reopened = await open(bytes)

		expect(tocRegions(reopened.editor.session)[0]?.updatable).toBe(true)
		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("updates only the page numbers of the file's table, its entries edited by hand kept byte for byte", async () => {
		const entry = (name: string, text: string, page: string): string =>
			`<w:hyperlink w:anchor="${name}" w:history="1"><w:r w:rsidR="00A1"><w:rPr><w:noProof/></w:rPr><w:t>${text}</w:t></w:r><w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:tab/></w:r>` +
			`<w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:instrText xml:space="preserve"> PAGEREF ${name} \\h </w:instrText></w:r>` +
			`<w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr></w:r><w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:t>${page}</w:t></w:r><w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>`
		const tocPr = '<w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>'
		const body =
			`<w:p w:rsidR="00B2">${tocPr}<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
			entry("_Toc100000001", "Intro, edited by hand", "7") +
			"</w:p>" +
			`<w:p>${tocPr}${entry("_Toc100000002", "Results", "9")}</w:p>` +
			`<w:p>${tocPr}<w:r><w:t>A line typed into the table</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc100000001"/><w:r><w:t>Introduction</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
			p("Text.") +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="2" w:name="_Toc100000002"/><w:r><w:t>Results</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>'
		const source = buildDocx(spec(body))
		const opened = await open(source)
		const editor = opened.editor
		const session = editor.session
		const [region] = tocRegions(session)

		expect(region?.source).toBe(false)
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual([
			"Intro, edited by hand\t[7]",
			"Results\t[9]",
			"A line typed into the table"
		])

		caretAt(editor, find(session.state.doc, "Results"))
		expect(await editor.execute({ type: "toc.update", pagesOnly: true })).toBe(true)
		await settleAll(editor)
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual([
			"Intro, edited by hand\t[2]",
			"Results\t[3]",
			"A line typed into the table"
		])

		// The markup is the file's but for the two page numbers.
		const bytes = await save(opened)
		const before = await read(source, "word/document.xml")
		const after = await read(bytes, "word/document.xml")
		const number = (page: string): string => `<w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:t>${page}</w:t></w:r>`

		expect(after).toBe(before.replace(number("7"), number("2")).replace(number("9"), number("3")))
		expect(pageDigest((await open(bytes)).editor.layout)).toEqual(await savedDigest(bytes))

		// The whole table rebuilt from the headings instead (Update entire table).
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
		await settleAll(editor)

		const [rebuilt] = tocRegions(session)

		expect(entries(session.state.doc, rebuilt?.from ?? 0, rebuilt?.to ?? 0)).toEqual(["Introduction\t[2]", "Results\t[3]"])
		expect(pageDigest((await open(await save(opened))).editor.layout)).toEqual(await savedDigest(await save(opened)))
	})

	it("keeps a title before the begin, the end's own paragraph and what follows the end when it rebuilds a table", async () => {
		const begin =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
		const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const tail = {
			// Word's paragraph after the last entry, holding the end.
			whole: `<w:p><w:r><w:t>Old entry</w:t></w:r></w:p><w:p>${end}<w:r><w:t xml:space="preserve"> After the end</w:t></w:r></w:p>`,
			// Text after the end in the last entry's paragraph.
			open: `<w:p><w:r><w:t>Old entry</w:t></w:r>${end}<w:r><w:t xml:space="preserve"> After the end</w:t></w:r></w:p>`
		}

		for (const [kind, last] of Object.entries(tail)) {
			const body =
				`<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Contents</w:t></w:r>${begin}</w:p>` + last + pageBreak + HEADINGS
			const opened = await open(spec(body))
			const editor = opened.editor
			const session = editor.session
			const [region] = tocRegions(session)

			expect(region?.updatable).toBe(true)
			caretAt(editor, find(session.state.doc, "Old entry"))
			expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
			await settleAll(editor)

			const [rebuilt] = tocRegions(session)
			const shown = entries(session.state.doc, rebuilt?.from ?? 0, rebuilt?.to ?? 0)

			// The title paragraph keeps its style and the code; the entries follow it.
			expect(session.state.doc.firstChild?.attrs["styleId"]).toBe("Heading4")
			expect(shown[0]).toBe("Contents")
			expect(shown.slice(1)).toEqual(
				kind === "whole"
					? ["Introduction\t[2]", "Background\t[3]", "Results\t[4]", " After the end"]
					: ["Introduction\t[2]", "Background\t[3]", "Results\t[4] After the end"]
			)

			const bytes = await save(opened)

			expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
			expect(tocRegions((await open(bytes)).editor.session)[0]?.updatable).toBe(true)
		}
	})

	it("records an update while tracking: page numbers each a field's update, a rebuilt table the old deleted and the new inserted", async () => {
		const entry = (name: string, text: string, page: string): string =>
			`<w:hyperlink w:anchor="${name}" w:history="1"><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/></w:r>` +
			`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF ${name} \\h </w:instrText></w:r>` +
			`<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${page}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>`
		const tocPr = '<w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>'
		const body =
			`<w:p>${tocPr}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
			`${entry("_Toc100000001", "Intro", "7")}</w:p>` +
			`<w:p>${tocPr}${entry("_Toc100000002", "Results", "9")}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc100000001"/><w:r><w:t>Introduction</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="2" w:name="_Toc100000002"/><w:r><w:t>Results</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>'
		const opened = await open(spec(body))
		const editor = opened.editor
		const session = editor.session
		const tables = (): string[][] => tocRegions(session).map(region => entries(session.state.doc, region.from, region.to))

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		caretAt(editor, find(session.state.doc, "Results"))

		// Page numbers only: each a tracked update of its field.
		expect(await editor.execute({ type: "toc.update", pagesOnly: true })).toBe(true)
		expect(tables()).toEqual([["Intro\t[2]", "Results\t[3]"]])
		expect(session.snapshot().review.revisionCount).toBe(2)

		const pages = await save(opened)

		expect((await read(pages, "word/document.xml")).match(/<w:del w:id="\d+" w:author="Ann Lee"/g)).toHaveLength(2)
		expect(pageDigest((await open(pages)).editor.layout)).toEqual(await savedDigest(pages))
		expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)
		expect(tables()).toEqual([["Intro\t[7]", "Results\t[9]"]])

		// The whole table: its old result deleted and the new one inserted, between its own code and end (as Word
		// records an update of a field).
		expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
		await settleAll(editor)
		expect(tocRegions(session)).toHaveLength(1)

		let deleted = ""
		let inserted = ""
		let chars = 0

		session.state.doc.descendants(node => {
			if (node.isText && docxSchema.marks.deletion.isInSet(node.marks) !== undefined) deleted += node.text ?? ""
			if (node.isText && docxSchema.marks.insertion.isInSet(node.marks) !== undefined) inserted += node.text ?? ""
			if (node.type === nodes.field_char && !isDeleted(node)) chars++

			return true
		})

		expect(deleted).toBe("IntroResults")
		expect(inserted).toBe("IntroductionResults")
		expect(chars).toBe(4)

		const rebuilt = await save(opened)
		const reopened = await open(rebuilt)

		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(rebuilt))

		// Accepted, the new table alone; rejected, the old one alone: whole fields either way.
		for (const accept of [true, false]) {
			const copy = await open(rebuilt)
			const copySession = copy.editor.session

			expect(await copy.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			expect(tocRegions(copySession).map(region => entries(copySession.state.doc, region.from, region.to))).toEqual([
				accept ? ["Introduction\t[2]", "Results\t[3]"] : ["Intro\t[7]", "Results\t[9]"]
			])

			const resolved = await save(copy)

			expect(await read(resolved, "word/document.xml")).not.toMatch(/<w:(del|ins) /)
			expect(pageDigest((await open(resolved)).editor.layout)).toEqual(await savedDigest(resolved))
		}
	})

	it("rejects a table rebuilt while tracking inside a content control back to the table it was", async () => {
		const entry = (name: string, text: string, code: string, after = ""): string =>
			`<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${code}<w:hyperlink w:anchor="${name}" w:history="1"><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/></w:r>` +
			`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF ${name} \\h </w:instrText></w:r>` +
			`<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>${after}</w:p>`
		const code =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
		const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
		// The end in a paragraph of its own (Word's), or after the last entry with text after it.
		const ends = [
			entry("_Toc100000002", "Results", "") + `<w:p>${end}</w:p>`,
			entry("_Toc100000002", "Results", "", `${end}<w:r><w:t xml:space="preserve"> after</w:t></w:r>`)
		]
		const body = (last: string): string =>
			'<w:sdt><w:sdtPr><w:id w:val="7"/><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>' +
			p("Contents") +
			entry("_Toc100000001", "Intro", code) +
			last +
			"</w:sdtContent></w:sdt>" +
			pageBreak +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc100000001"/><w:r><w:t>Introduction</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="2" w:name="_Toc100000002"/><w:r><w:t>Method</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>' +
			heading(1, "Results")

		for (const [last, reopen] of ends.flatMap(last => [false, true].map(reopen => [last, reopen] as const))) {
			const source = buildDocx(spec(body(last)))
			const original = await open(source)
			const opened = await open(source)
			const session = opened.editor.session

			opened.context.identity.author = "Ann Lee"
			opened.context.review.tracking = true
			caretAt(opened.editor, find(session.state.doc, "Intro"))
			expect(await opened.editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
			await settleAll(opened.editor)

			const target = reopen ? await open(await save(opened)) : opened

			expect(await target.editor.execute({ type: "review.rejectAll" })).toBe(true)
			await settleAll(target.editor)
			expect(target.editor.session.snapshot().review.revisionCount).toBe(0)
			expect(pageDigest(target.editor.layout)).toEqual(pageDigest(original.editor.layout))

			const bytes = await save(target)

			expect(await read(bytes, "word/document.xml")).not.toMatch(/<w:(del|ins) /)
		}
	})

	it("keeps a table's code with its separate when a paragraph splits inside it, and its characters whole in a tracked deletion", async () => {
		const body =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry one</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Entry two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
			p("After")
		const opened = await open(spec(body))
		const editor = opened.editor
		const session = editor.session
		const chars = (): string[] => {
			const out: string[] = []

			session.state.doc.descendants((node, pos) => {
				if (node.type === nodes.field_char)
					out.push(
						`${String(session.state.doc.resolve(pos).index(0))}:${node.attrs["kind"] as string}${isDeleted(node) ? "-" : ""}`
					)

				return true
			})

			return out
		}

		expect(chars()).toEqual(["0:begin", "0:instruction", "0:separate", "1:end"])

		// Enter between the begin and its instruction: the code goes with its separate.
		expect(session.dispatch(session.state.tr.split(2))).toBe(true)
		expect(chars()).toEqual(["1:begin", "1:instruction", "1:separate", "2:end"])
		expect(await editor.execute({ type: "history.undo" })).toBe(true)

		// A tracked deletion of the instruction and the first entry: the whole field is deleted, tracked, as an
		// untracked deletion deletes it (its paragraph mark inside it too).
		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2, find(session.state.doc, " one"))))
		session.dispatch(session.state.tr.deleteSelection())
		expect(chars()).toEqual(["0:begin-", "0:instruction-", "0:separate-", "1:end-"])

		const bytes = await save(opened)
		const reopened = await open(bytes)

		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))

		// Rejected, the table is back; accepted, it is gone and its paragraphs joined.
		expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)
		expect(chars()).toEqual(["0:begin", "0:instruction", "0:separate", "1:end"])
		expect(await reopened.editor.execute({ type: "review.acceptAll" })).toBe(true)
		expect(tocRegions(reopened.editor.session)).toHaveLength(0)
		expect(reopened.editor.session.state.doc.textContent).toBe("After")
	})

	it("deletes a table another author inserted whole while tracking, inserted and deleted, or for real when its own", async () => {
		for (const own of [false, true]) {
			const opened = await open(spec(HEADINGS))
			const editor = opened.editor
			const session = editor.session

			opened.context.review.tracking = true
			opened.context.identity.author = "Bob"
			caretAt(editor, 1)
			expect(await editor.execute({ type: "toc.insert", levels: 2, hyperlinks: true })).toBe(true)
			await settleAll(editor)

			if (!own) opened.context.identity.author = "Ann Lee"

			// Its begin, code and first entry, tracked.
			const [region] = tocRegions(session)
			const from = region?.from ?? 0

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from + 1, from + 6)))
			session.dispatch(session.state.tr.deleteSelection())

			let chars = 0
			let deleted = 0

			session.state.doc.descendants(node => {
				if (node.type === nodes.field_char) {
					chars++

					if (isDeleted(node)) deleted++
				}

				return true
			})

			expect(own ? chars : deleted).toBe(own ? 0 : chars)
			expect(tocRegions(session)).toHaveLength(0)

			const bytes = await save(opened)
			const reopened = await open(bytes)
			const codes = (doc: ProseMirrorNode): string[] => {
				const out: string[] = []

				doc.descendants(node => {
					if (node.type === nodes.field) out.push(node.attrs["instruction"] as string)

					return true
				})

				return out
			}

			// The entries' page references, inserted and deleted, read back with their codes.
			expect(codes(reopened.editor.session.state.doc)).toEqual(codes(session.state.doc))

			expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
			// Accepted, no table.
			await editor.execute({ type: "review.acceptAll" })
			expect(tocRegions(session)).toHaveLength(0)
		}
	})

	it("refuses a move that would take a table apart, and moves its paragraphs that keep it whole", async () => {
		const opened = await open(
			spec(
				'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
					'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>One</w:t></w:r></w:p>' +
					'<w:p><w:r><w:t>Two</w:t></w:r></w:p><w:p><w:r><w:t>Three</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
					p("After")
			)
		)
		const session = opened.editor.session
		const move = (index: number, to: number): boolean => {
			const doc = session.state.doc
			let from = 0

			for (let k = 0; k < index; k++) from += doc.child(k).nodeSize

			const slice = doc.slice(from, from + doc.child(index).nodeSize)
			let at = 0

			for (let k = 0; k < to; k++) at += doc.child(k).nodeSize

			const tr = session.state.tr.insert(at, slice.content)

			return session.dispatch(tr.delete(tr.mapping.map(from), tr.mapping.map(from + doc.child(index).nodeSize)))
		}
		const texts = (): string[] => {
			const out: string[] = []

			session.state.doc.forEach(node => out.push(node.textContent))

			return out
		}

		// Its first paragraph (begin, code, separate) below its end: refused, nothing changes.
		expect(move(0, 4)).toBe(false)
		expect(tocRegions(session)).toHaveLength(1)
		// A paragraph between its begin and end moved out of it, after the document's last: the table stays whole.
		expect(move(1, 4)).toBe(true)
		expect(texts()).toEqual(["One", "Three", "After", "Two"])
		expect(tocRegions(session)).toHaveLength(1)
		// Saved: the table's characters all there, in order.
		expect((await read(await save(opened), "word/document.xml")).match(/<w:fldChar /g)).toHaveLength(3)
	})

	it("deletes a table whole when an edit takes its end", async () => {
		const opened = await open(spec(HEADINGS))
		const editor = opened.editor
		const session = editor.session

		caretAt(editor, 1)
		await editor.execute({ type: "toc.insert", levels: 2, hyperlinks: false })
		await settleAll(editor)

		const [region] = tocRegions(session)
		let end = -1

		session.state.doc.nodesBetween(region?.from ?? 0, region?.to ?? 0, (node, pos) => {
			if (node.type === nodes.field_char && node.attrs["kind"] === "end") end = pos

			return true
		})

		// Backspace over the end character.
		expect(session.dispatch(session.state.tr.delete(end, end + 1))).toBe(true)
		expect(tocRegions(session)).toHaveLength(0)

		let chars = 0

		session.state.doc.descendants(node => {
			if (node.type === nodes.field_char) chars++

			return true
		})

		expect(chars).toBe(0)
		expect(find(session.state.doc, "Introduction")).toBeGreaterThan(0)
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(tocRegions(session)).toHaveLength(1)
	})

	it("deletes a table whole when an edit takes its separate or an instruction text, and saves", async () => {
		const body =
			p("Before") +
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>One</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
			p("After")

		for (const kind of ["separate", "instruction"]) {
			const opened = await open(spec(body))
			const session = opened.editor.session
			let at = -1

			session.state.doc.descendants((node, pos) => {
				if (node.type === nodes.field_char && node.attrs["kind"] === kind) at = pos

				return at < 0
			})

			// The character and a little of what follows it.
			expect(session.dispatch(session.state.tr.delete(at, kind === "separate" ? at + 3 : at + 1))).toBe(true)
			expect(tocRegions(session)).toHaveLength(0)

			const texts: string[] = []
			let chars = 0

			session.state.doc.descendants(node => {
				if (node.type === nodes.field_char) chars++
				if (node.isTextblock) texts.push(node.textContent)

				return true
			})

			expect(chars).toBe(0)
			expect(texts).toEqual(["Before", "", "After"])

			const bytes = await save(opened)

			expect(await read(bytes, "word/document.xml")).not.toContain("fldChar")
			await settleAll(opened.editor)
			expect(pageDigest(opened.editor.layout)).toEqual(await savedDigest(bytes))
		}
	})

	it("inserts a table as a tracked insertion while tracking, or untracked while tracked changes hold no fields", async () => {
		const opened = await open(spec(HEADINGS))
		const editor = opened.editor

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		caretAt(editor, find(editor.session.state.doc, "Introduction"))
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const bytes = await save(opened)
		const xml = await read(bytes, "word/document.xml")

		// Recorded whole (field characters and fields in w:ins), or not at all: never half.
		if (markable(nodes.field_char.create()) && markable(nodes.field.create())) {
			expect(xml).toMatch(/<w:ins w:id="\d+" w:author="Ann Lee"[^>]*><w:r><w:fldChar w:fldCharType="begin"\/>/)
		} else {
			expect(xml).not.toContain("<w:ins ")
			expect(xml).toContain(
				'<w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>'
			)
		}

		expect(pageDigest((await open(bytes)).editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("keeps a table of one entry over two paragraphs, its end in the second", async () => {
		const opened = await open(spec(p("Start") + heading(1, "Chapter") + heading(2, "Section")))
		const editor = opened.editor
		const session = editor.session

		caretAt(editor, 1)
		expect(await editor.execute({ type: "toc.insert", levels: 1, hyperlinks: false })).toBe(true)
		await settleAll(editor)

		const [region] = tocRegions(session)

		// One paragraph would read back as a field of that paragraph, not a table.
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual(["Chapter\t[1]", ""])

		const bytes = await save(opened)

		expect(entries((await open(bytes)).editor.session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual(["Chapter\t[1]", ""])
	})

	it("updates a table's page numbers with Update Field anywhere in it", async () => {
		const opened = await open(spec(HEADINGS))
		const editor = opened.editor
		const session = editor.session

		caretAt(editor, 1)
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const [region] = tocRegions(session)

		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual([
			"Introduction\t[1]",
			"Background\t[2]",
			"Results\t[3]"
		])

		// Every heading a page further on.
		const contents = session.state.doc.resolve(find(session.state.doc, "Contents")).after()

		session.dispatch(session.state.tr.insert(contents, nodes.paragraph.create(null, nodes.break.create({ type: "page" }))))
		await settleAll(editor)

		// The caret in the middle entry's text, on no field.
		caretAt(editor, find(session.state.doc, "Background") + 2)
		expect(editor.canExecute("field.update")).toBe(true)
		expect(await editor.execute({ type: "field.update" })).toBe(true)
		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual([
			"Introduction\t[2]",
			"Background\t[3]",
			"Results\t[4]"
		])
	})

	it("builds entries and references over symbols without a character, leaving the symbol out", async () => {
		const symbol = (char: string): string => `<w:r><w:sym w:font="Wingdings"${char}/></w:r>`
		const symbolHeading = (name: string, char: string): string =>
			`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${name}</w:t></w:r>${symbol(char)}<w:r><w:t>end</w:t></w:r></w:p>`
		const reference =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF Target \\h </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>stale</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const opened = await open(
			spec(
				p("Contents") +
					symbolHeading("None", "") +
					symbolHeading("Past", ' w:char="00110000"') +
					symbolHeading("Zero", ' w:char="0"') +
					`<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t>Ref</w:t></w:r>${symbol("")}${symbol(' w:char="00110000"')}${symbol(' w:char="0"')}<w:r><w:t>end</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>` +
					reference
			)
		)
		const editor = opened.editor
		const session = editor.session

		caretAt(editor, find(session.state.doc, "Contents"))
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const [region] = tocRegions(session)

		expect(entries(session.state.doc, region?.from ?? 0, region?.to ?? 0)).toEqual(["Noneend\t[1]", "Pastend\t[1]", "Zeroend\t[1]"])
		expect(session.state.doc.textContent).not.toContain("\u0000")
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)

		const results: string[] = []

		session.state.doc.descendants(node => {
			if (node.type === nodes.field && node.attrs["type"] === "REF") results.push(node.attrs["result"] as string)
		})
		expect(results).toEqual(["Refend"])
		expect(await read(await save(opened), "word/document.xml")).not.toContain("\u0000")
	})

	it("rebuilds a table of figures (\\c) in Word's table of figures style", async () => {
		const caption = (n: string, text: string): string =>
			'<w:p><w:r><w:t xml:space="preserve">Figure </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r>' +
			`<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${n}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve">: ${text}</w:t></w:r></w:p>`
		const body =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\h \\z \\c "Figure" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
			'<w:r><w:t>Old</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
			caption("1", "One") +
			pageBreak +
			caption("2", "Two")
		const opened = await open(spec(body))
		const editor = opened.editor

		caretAt(editor, find(editor.session.state.doc, "Old"))
		expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(true)
		await settleAll(editor)

		const bytes = await save(opened)
		const xml = await read(bytes, "word/document.xml")

		expect(xml.match(/<w:pStyle w:val="TableofFigures"\/>/g)).toHaveLength(2)
		expect(xml).not.toContain("TOC1")
		expect(await read(bytes, "word/styles.xml")).toMatch(
			/<w:style w:type="paragraph" w:styleId="TableofFigures"><w:name w:val="table of figures"\/>/
		)
		expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("reads Word's switches", () => {
		const options = tocOptions(parseFieldCode(' TOC \\o "2-4" \\t "Appendix,1;Annex;Quote,3" \\n "3-9" \\p "-" \\h \\b Part '))

		expect(options.headings).toEqual([2, 4])
		expect([...options.styles]).toEqual([
			["appendix", 1],
			["annex", 1],
			["quote", 3]
		])
		expect(options.omit).toEqual([3, 9])
		expect(options.separator).toBe("-")
		expect(options.hyperlinks).toBe(true)
		expect(options.bookmark).toBe("Part")
		expect(options.supported).toBe(true)
		expect(tocOptions(parseFieldCode(" TOC \\f \\l 1-2 ")).supported).toBe(false)
	})
})
