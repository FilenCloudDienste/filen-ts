import { existsSync } from "node:fs"
import type { Node } from "prosemirror-model"
import { NodeSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { ObjectKind, RevisionView } from "@filen/office/core/docx"
import { docxSchema, equationTree, selectEquation, storyReviewIndex, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { encodeUtf8, decodeUtf8 } from "@filen/office/core/xml"
import { ReviewKind } from "../core/docx/review/index"
import { ommlStringTree, treeChanges, treeXml, diffTrees, type XElement } from "../core/math/ommlTrack"
import { openBytes } from "./docxEditFixtures"
import { NAMESPACES, buildDocx, p } from "./docxSynthetic"
import { SCHEMA_ARCHIVE, XMLLINT, schemaOracle } from "./fuzz/harness"
import { layOut } from "./layoutFixtures"
import { mathGate } from "./mathGate"
import { pageDigest, pagedEditor, settleAll } from "./pagedFixtures"
import { EditAnnotations } from "../core/docx/paged/annotations"
import { modelAuthors, revisionAuthors } from "../core/docx/layout/styles"

// Tracked changes inside equations, as Word writes them: math runs in w:ins / w:del, an object's characters
// marked in its m:ctrlPr. Read (each change in the review index with its author), shown per revision view
// (the editor's pages as a fresh layout of the saved file), accepted and rejected (one or all), recorded by
// inserting, editing and deleting equations while tracking, undone exactly, saved and read back the same.

const nodes = docxSchema.nodes
const FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'
const ADA = 'w:author="Ada" w:date="2026-01-01T10:00:00Z"'
const BOB = 'w:author="Bob" w:date="2026-02-02T11:00:00Z"'
const run = (text: string): string => `<m:r>${FONT}<m:t>${text}</m:t></m:r>`

// A fraction Ada inserted (its bar and both runs).
const INSERTED =
	`<w:p><w:r><w:t xml:space="preserve">Inserted </w:t></w:r><m:oMath><m:f><m:fPr><m:ctrlPr><w:ins w:id="11" ${ADA}>${FONT}</w:ins></m:ctrlPr></m:fPr>` +
	`<m:num><w:ins w:id="12" ${ADA}>${run("a")}</w:ins></m:num><m:den><w:ins w:id="13" ${ADA}>${run("b")}</w:ins></m:den></m:f></m:oMath></w:p>`
// x squared Bob changed to x cubed.
const EDITED =
	`<w:p><w:r><w:t xml:space="preserve">Edited </w:t></w:r><m:oMath><m:sSup><m:sSupPr><m:ctrlPr>${FONT}</m:ctrlPr></m:sSupPr><m:e>${run("x")}</m:e>` +
	`<m:sup><w:del w:id="21" ${BOB}>${run("2")}</w:del><w:ins w:id="22" ${BOB}>${run("3")}</w:ins></m:sup></m:sSup></m:oMath></w:p>`
// A square root Bob deleted.
const DELETED =
	`<w:p><w:r><w:t xml:space="preserve">Deleted </w:t></w:r><m:oMath><m:rad><m:radPr><m:degHide m:val="1"/><m:ctrlPr><w:del w:id="31" ${BOB}>${FONT}</w:del></m:ctrlPr></m:radPr>` +
	`<m:deg/><m:e><w:del w:id="32" ${BOB}>${run("y")}</w:del></m:e></m:rad></m:oMath></w:p>`

function docx(body: string): Uint8Array {
	return buildDocx({
		document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`
	})
}

const FIXTURE = docx(INSERTED + EDITED + DELETED + p("Plain text"))

async function run_(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	const result = await editor.execute(command)

	await settleAll(editor)

	return result
}

function maths(doc: Node): { readonly node: Node; readonly pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.math) out.push({ node, pos })
	})

	return out
}

async function saved(editor: PagedEditor, opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<Uint8Array> {
	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	return result.bytes
}

async function documentXml(bytes: Uint8Array): Promise<string> {
	return decodeUtf8(await (await openBytes(bytes)).pkg.opc.read("word/document.xml"))
}

// The tracked changes of the body as kind and author, in order (what balloons and Prev/Next list).
function review(editor: PagedEditor): string[] {
	const session = editor.session

	return storyReviewIndex(session)
		.entries()
		.filter(entry => entry.kind > ReviewKind.COMMENT_REFERENCE)
		.map(entry => {
			const node = session.state.doc.nodeAt(entry.from)

			return `${entry.kind === ReviewKind.INSERTION ? "ins" : "del"}@${node?.type === nodes.math ? "math" : "text"}`
		})
}

function tracked(editor: PagedEditor, author: string): void {
	editor.session.context.review.tracking = true
	editor.session.context.identity.author = author
}

// The text of a math tree's tokens, with the revision each sits in (+ inserted, - deleted).
function shown(tree: unknown, inside = ""): string {
	if (typeof tree === "string") return inside === "" ? tree : `${inside}${tree}`

	const element = tree as { attributes?: { revision?: number }; children: unknown[] }
	const revision = element.attributes?.revision
	const mark = revision === undefined ? inside : (revision & 3) === 1 ? "+" : "-"

	return element.children.map(child => shown(child, mark)).join("")
}

describe("tracked changes inside equations read from the file", () => {
	it("lists each change with its kind, grouped by author and date", async () => {
		const { editor } = await pagedEditor(FIXTURE)

		expect(review(editor)).toEqual(["ins@math", "del@math", "ins@math", "del@math"])
		expect(storyReviewIndex(editor.session).revisionCount).toBe(4)
	})

	it("shows them per revision view, the pages as a fresh layout of the file", async () => {
		const { editor } = await pagedEditor(FIXTURE)
		const [inserted, edited, deleted] = maths(editor.session.state.doc)
		const part = editor.session.story.part
		const view = (node: Node | undefined, name: "final" | "original" | "markup"): string =>
			shown(equationTree(node as Node, part, { view: name }))

		expect(view(inserted?.node, "final")).toBe("ab")
		expect(view(inserted?.node, "original")).toBe("")
		expect(view(inserted?.node, "markup")).toBe("+a+b")
		expect(view(edited?.node, "final")).toBe("x3")
		expect(view(edited?.node, "original")).toBe("x2")
		expect(view(edited?.node, "markup")).toBe("x-2+3")
		expect(view(deleted?.node, "final")).toBe("")
		expect(view(deleted?.node, "markup")).toBe("-y")

		for (const revisionView of [RevisionView.Markup, RevisionView.Original, RevisionView.Final]) {
			editor.setView(revisionView)
			await settleAll(editor)
			expect(pageDigest(editor.layout), String(revisionView)).toEqual(pageDigest(await layOut(FIXTURE, { view: revisionView })))
		}

		// Each view lays the equations out at their own size: x²³ is wider with both scripts shown.
		const widths = (layout: Awaited<ReturnType<typeof layOut>>): number[] => {
			const objects = layout.objects

			return [...Array(objects.count).keys()].filter(id => objects.kinds[id] === ObjectKind.MATH).map(id => objects.widths[id] ?? 0)
		}
		const markupWidths = widths(await layOut(FIXTURE, { view: RevisionView.Markup }))
		const finalWidths = widths(await layOut(FIXTURE, { view: RevisionView.Final }))

		expect(markupWidths[1] ?? 0).toBeGreaterThan(finalWidths[1] ?? 0)
		expect(finalWidths[2]).toBe(0)
	})

	it("accepts and rejects one change, then all of them", async () => {
		const opened = await pagedEditor(FIXTURE)
		const editor = opened.editor
		const index = storyReviewIndex(editor.session)
		const bobDeletion = index.entries().find(entry => entry.kind === ReviewKind.DELETION)

		expect(await run_(editor, { type: "review.reject", id: bobDeletion?.id ?? "" })).toBe(true)
		// Bob's deletion of the 2 is rejected: it stays, as does his insertion of the 3.
		expect(shown(equationTree(maths(editor.session.state.doc)[1]?.node as Node, editor.session.story.part))).toBe("x23")
		expect(review(editor)).toEqual(["ins@math", "ins@math", "del@math"])

		expect(await run_(editor, { type: "review.acceptAll" })).toBe(true)
		expect(review(editor)).toEqual([])

		const xml = await documentXml(await saved(editor, opened))

		expect(xml).not.toMatch(/<w:(ins|del)\b/)
		// The deleted root went; the fraction and x²³ stay, without their marks.
		expect(maths(editor.session.state.doc)).toHaveLength(2)
		expect(xml).toContain('<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr></m:ctrlPr>')
	})

	it("rejects all: inserted equations go, deleted ones come back", async () => {
		const opened = await pagedEditor(FIXTURE)
		const editor = opened.editor

		expect(await run_(editor, { type: "review.rejectAll" })).toBe(true)

		const found = maths(editor.session.state.doc)

		expect(found).toHaveLength(2)
		expect(found.map(({ node }) => shown(equationTree(node, editor.session.story.part)))).toEqual(["x2", "y"])
		expect(await documentXml(await saved(editor, opened))).not.toMatch(/<w:(ins|del)\b/)
	})

	it("saves a file holding tracked equations unedited byte for byte, and with an edit elsewhere keeps them as they are", async () => {
		const opened = await pagedEditor(FIXTURE)
		const editor = opened.editor
		const unedited = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

		expect(unedited.bytes === undefined || (await documentXml(unedited.bytes)) === (await documentXml(FIXTURE))).toBe(true)

		const end = editor.session.state.doc.content.size - 1

		editor.dispatch(editor.session.state.tr.insertText("!", end))

		const xml = await documentXml(await saved(editor, opened))

		for (const equation of [INSERTED, EDITED, DELETED]) expect(xml).toContain(equation.slice(equation.indexOf("<m:oMath>")))
	})
})

describe("tracked changes inside equations of stories not opened, and their authors", () => {
	it("counts a header whose only changes are inside an equation: Accept all reaches it unopened", async () => {
		const bytes = buildDocx({
			body: p("Body text") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: `<w:p><m:oMath><w:ins w:id="41" ${ADA}>${run("h")}</w:ins></m:oMath></w:p>` }
		})
		const opened = await pagedEditor(bytes)
		const editor = opened.editor

		expect(editor.sessions).toHaveLength(1)
		expect(editor.canExecute("review.acceptAll")).toBe(true)
		expect(await run_(editor, { type: "review.acceptAll" })).toBe(true)
		expect(editor.canExecute("review.acceptAll")).toBe(false)

		const header = decodeUtf8(await (await openBytes(await saved(editor, opened))).pkg.opc.read("word/header1.xml"))

		expect(header).toContain("<m:oMath><m:r>")
		expect(header).not.toMatch(/<w:ins\b/)
	})

	it("numbers an author who changed only equations from the model, one colour in the equation and its balloon", async () => {
		const bytes = docx(
			`<w:p><w:ins w:id="51" ${ADA}><w:r><w:t>text</w:t></w:r></w:ins></w:p>` +
				`<w:p><m:oMath><w:ins w:id="52" w:author="Eve" w:date="2026-03-03T00:00:00Z">${run("e")}</w:ins></m:oMath></w:p>`
		)
		const { editor } = await pagedEditor(bytes)
		const fresh = revisionAuthors((await openBytes(bytes)).model)

		// Every surface numbers from its model alike, whatever it meets first.
		expect(fresh.names).toEqual(["Ada", "Eve"])
		expect(revisionAuthors(editor.edits.model).index("Eve")).toBe(fresh.index("Eve"))

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const data = new EditAnnotations(editor).read([0])
		const balloon = data.revisions.find(revision => revision.target === "text" && data.authors[revision.author] === "Eve")
		const equation = maths(editor.session.state.doc)[0]?.node as Node
		const tree = equationTree(equation, editor.session.story.part, {
			view: "markup",
			author: revisionAuthors(editor.edits.model).index
		})
		const slot = ((tree?.children[0] as { attributes?: { revision?: number } } | undefined)?.attributes?.revision ?? 0) >> 2

		expect(balloon).toBeDefined()
		expect(slot).toBe(((balloon?.author ?? -1) % 8) + 1)
	})
})

describe("authors new in the session", () => {
	it("keep one colour on the pages, in equations and in balloons, whatever surface meets them first", async () => {
		const opened = await pagedEditor(docx(p("One") + p("Two")))
		const editor = opened.editor
		const shared = modelAuthors(editor.edits.model)

		expect(modelAuthors(editor.edits.model)).toBe(shared)

		// Yan types, then Zed inserts an equation; a surface asks for Zed before Yan.
		tracked(editor, "Yan")
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 2)))
		editor.dispatch(editor.session.state.tr.insertText("typed"))
		editor.session.context.identity.author = "Zed"
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 3)))
		expect(await run_(editor, { type: "equation.insert", latex: "z", display: false })).toBe(true)

		const zed = shared.index("Zed")

		editor.setView(RevisionView.Markup)
		await settleAll(editor)

		const data = new EditAnnotations(editor).read([0])
		const author = (name: string): number | undefined => data.revisions.find(revision => data.authors[revision.author] === name)?.author
		const equation = maths(editor.session.state.doc)[0]?.node as Node
		const tree = equationTree(equation, editor.session.story.part, { view: "markup", author: shared.index })
		const slot = ((tree?.children[0] as { attributes?: { revision?: number } } | undefined)?.attributes?.revision ?? 0) >> 2

		expect(author("Zed")).toBe(zed)
		expect(author("Yan")).toBe(shared.index("Yan"))
		expect(slot).toBe((zed % 8) + 1)
	})
})

describe("tracked changes recorded in equations", () => {
	it("records a new equation as inserted, read back the same after a save", async () => {
		const opened = await pagedEditor(docx(p("Left right")))
		const editor = opened.editor

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 5)))
		tracked(editor, "Ada")
		expect(await run_(editor, { type: "equation.insert", latex: "\\frac{a}{b}", display: false })).toBe(true)
		expect(review(editor)).toEqual(["ins@math"])

		const bytes = await saved(editor, opened)
		const xml = await documentXml(bytes)

		expect(xml).toMatch(
			/<m:fPr><m:ctrlPr><w:ins w:id="\d+" w:author="Ada" w:date="[^"]+"><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><\/w:rPr><\/w:ins><\/m:ctrlPr><\/m:fPr>/
		)
		expect(xml).toMatch(
			/<m:num><w:ins w:id="\d+" w:author="Ada" w:date="[^"]+"><m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"\/><\/w:rPr><m:t>a<\/m:t><\/m:r><\/w:ins><\/m:num>/
		)

		const reopened = await pagedEditor(bytes)

		expect(review(reopened.editor)).toEqual(["ins@math"])
		expect(await run_(reopened.editor, { type: "review.rejectAll" })).toBe(true)
		expect(maths(reopened.editor.session.state.doc)).toHaveLength(0)
	})

	it("records an edit as Word does: retyped characters deleted and inserted, a changed object whole", async () => {
		const opened = await pagedEditor(
			docx(
				p("Text") +
					`<w:p><m:oMath>${run("a")}<m:r><m:t>+</m:t></m:r><m:f><m:num>${run("1")}</m:num><m:den>${run("2")}</m:den></m:f></m:oMath></w:p>`
			)
		)
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1
		const before = editor.session.state.doc

		tracked(editor, "Bob")
		expect(selectEquation(editor.session, pos)).toBe(true)
		expect(editor.canExecute("equation.edit")).toBe(true)
		expect(await run_(editor, { type: "equation.edit", latex: "b+\\sqrt{1}" })).toBe(true)

		const node = editor.session.state.doc.nodeAt(pos) as Node
		const part = editor.session.story.part

		expect(shown(equationTree(node, part, { view: "markup" }))).toBe("-a+b+-1-2+1")
		expect(shown(equationTree(node, part, { view: "original" }))).toBe("a+12")
		expect(shown(equationTree(node, part))).toBe("b+1")
		// Word's changes: those side by side, of one author, kind and date, as one; the unchanged + parts them.
		expect(review(editor)).toEqual(["del@math", "ins@math", "del@math", "ins@math"])

		const xml = await documentXml(await saved(editor, opened))

		// The fraction deleted whole (its bar marked, its runs wrapped), the root inserted whole.
		expect(xml).toMatch(/<m:f><m:fPr><m:ctrlPr><w:del w:id="\d+" w:author="Bob"/)
		expect(xml).toMatch(/<m:rad><m:radPr><m:degHide m:val="1"\/><m:ctrlPr><w:ins w:id="\d+" w:author="Bob"/)
		// The run of the unchanged + keeps its own properties.
		expect(xml).toContain("<m:r><m:t>+</m:t></m:r>")

		// Undone, exactly the document before.
		expect(await run_(editor, { type: "history.undo" })).toBe(true)
		expect(editor.session.state.doc.eq(before)).toBe(true)
	})

	it("records an equation deleted while tracking inside it, and deletes the author's own insertion for real", async () => {
		const opened = await pagedEditor(docx(p("Text") + `<w:p><m:oMath>${run("z")}</m:oMath></w:p>`))
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		tracked(editor, "Bob")
		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, pos)))
		editor.dispatch(editor.session.state.tr.deleteSelection())
		await settleAll(editor)

		const node = editor.session.state.doc.nodeAt(pos) as Node

		expect(node.type).toBe(nodes.math)
		expect(shown(equationTree(node, editor.session.story.part, { view: "markup" }))).toBe("-z")
		expect(review(editor)).toEqual(["del@math"])
		expect(await documentXml(await saved(editor, opened))).toMatch(/<m:oMath><w:del w:id="\d+" w:author="Bob"[^>]*><m:r>/)
		expect(await run_(editor, { type: "review.rejectAll" })).toBe(true)
		expect(shown(equationTree(editor.session.state.doc.nodeAt(pos) as Node, editor.session.story.part))).toBe("z")

		// Bob's own new equation, deleted again: gone.
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 3)))
		await run_(editor, { type: "equation.insert", latex: "q", display: false })

		const own = maths(editor.session.state.doc).find(found => found.node.attrs["src"] === -1)

		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, own?.pos ?? -1)))
		editor.dispatch(editor.session.state.tr.deleteSelection())
		expect(maths(editor.session.state.doc).filter(found => found.node.attrs["src"] === -1)).toHaveLength(0)
	})

	it("keeps an earlier change of another author when an edit takes back what they inserted", () => {
		const before = ommlStringTree(`<m:oMath><w:ins w:id="1" ${ADA}><m:r><m:t>ab</m:t></m:r></w:ins></m:oMath>`) as XElement
		const after = ommlStringTree("<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath>") as XElement
		const changed = treeXml(diffTrees(before, after, { author: "Bob", date: "2026-03-03T00:00:00Z" }, "9", "8"))

		expect(changed).toBe(
			`<m:oMath><w:ins w:id="1" ${ADA}><m:r><m:t>a</m:t></m:r><w:del w:id="8" w:author="Bob" w:date="2026-03-03T00:00:00Z"><m:r><m:t>b</m:t></m:r></w:del></w:ins></m:oMath>`
		)
		expect(treeChanges(ommlStringTree(changed) as XElement).map(change => `${change.kind}:${change.author}`)).toEqual([
			"ins:Ada",
			"del:Bob"
		])
	})
})

// ---- gate 2 and the schemas ---------------------------------------------------------------------------

const gate = (inner: string, source = ""): Promise<string | undefined> => mathGate(inner, { source })

// ---- review fixes ---------------------------------------------------------------------------------------------

const W16DU = 'xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"'
const plainRun = (text: string): string => `<m:r><m:t>${text}</m:t></m:r>`

function docxWith(body: string, extra: string): Uint8Array {
	return buildDocx({
		document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES} ${extra}><w:body>${body}</w:body></w:document>`
	})
}

describe("equations with Word 365 markup, and commands that could not be saved", () => {
	const WORD365 =
		`<w:p><m:oMath><w:ins w:id="5" ${ADA} w16du:dateUtc="2026-01-01T10:00:00Z">${plainRun("a")}</w:ins>${plainRun("+")}` +
		`<w:del w:id="6" ${BOB} w16du:dateUtc="2026-02-02T11:00:00Z">${plainRun("b")}</w:del>` +
		'<m:r><w:rPr><w14:textOutline w14:w="9525"><w14:noFill/></w14:textOutline></w:rPr><m:t>c</m:t></m:r>' +
		`<m:r><m:rPr><m:brk m:alnAt="1"/></m:rPr><m:t>=</m:t></m:r>${plainRun("d")}</m:oMath></w:p>`

	it("accepts one change, all, edits while tracking and deletes around them, each saved", async () => {
		for (const step of ["one", "all", "edit", "delete"] as const) {
			const opened = await pagedEditor(docxWith(p("Text") + WORD365, W16DU))
			const editor = opened.editor
			const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

			if (step === "one") {
				const first = storyReviewIndex(editor.session)
					.entries()
					.find(entry => entry.kind === ReviewKind.INSERTION)

				expect(await run_(editor, { type: "review.accept", id: first?.id ?? "" })).toBe(true)
			} else if (step === "all") {
				expect(await run_(editor, { type: "review.acceptAll" })).toBe(true)
			} else if (step === "edit") {
				tracked(editor, "Cy")
				selectEquation(editor.session, pos)
				expect(await run_(editor, { type: "equation.edit", latex: "a+c=e" })).toBe(true)
			} else {
				tracked(editor, "Cy")
				editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 2, pos + 2)))
				editor.dispatch(editor.session.state.tr.deleteSelection())
			}

			const xml = await documentXml(await saved(editor, opened))

			// The part's own declarations hold; Word's markup stays as it was.
			expect(xml, step).toContain("<w14:textOutline")
			expect(xml, step).toContain('<m:brk m:alnAt="1"/>')
			expect(xml, step).not.toMatch(/<m:oMath xmlns/)
		}
	})

	it("refuses a command whose equation could not be saved, and the save goes on", async () => {
		// An element Office Math does not have, inside a tracked equation.
		const opened = await pagedEditor(
			docx(p("Text") + `<w:p><m:oMath><w:ins w:id="5" ${ADA}>${plainRun("a")}</w:ins><m:zzz/></m:oMath></w:p>`)
		)
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		expect(await run_(editor, { type: "review.acceptAll" })).toBe(false)
		selectEquation(editor.session, pos)
		expect(await run_(editor, { type: "equation.edit", latex: "b" })).toBe(false)
		expect((await documentXml(await saved(editor, opened))).includes("<m:zzz/>")).toBe(true)
	})
})

describe("edits, deletions and changes of equations holding changes", () => {
	it("an untracked edit keeps the changes the equation holds", async () => {
		const opened = await pagedEditor(
			docx(
				p("T") +
					`<w:p><m:oMath><w:ins w:id="5" ${ADA}>${plainRun("a")}</w:ins>${plainRun("+")}<w:del w:id="6" ${BOB}>${plainRun("b")}</w:del></m:oMath></w:p>`
			)
		)
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		selectEquation(editor.session, pos)
		expect(await run_(editor, { type: "equation.edit", latex: "a+c" })).toBe(true)
		expect(review(editor)).toEqual(["ins@math", "del@math"])
		expect(shown(equationTree(editor.session.state.doc.nodeAt(pos) as Node, editor.session.story.part, { view: "markup" }))).toBe(
			"+a+-bc"
		)
	})

	it("deleting the author's own object keeps another author's insertion inside it, marked deleted", async () => {
		const opened = await pagedEditor(
			docx(
				p("T") +
					`<w:p><m:oMath><m:f><m:fPr><m:ctrlPr><w:ins w:id="5" ${ADA}><w:rPr/></w:ins></m:ctrlPr></m:fPr>` +
					`<m:num><w:ins w:id="6" ${ADA}>${plainRun("a")}</w:ins><w:ins w:id="7" ${BOB}>${plainRun("b")}</w:ins></m:num><m:den/></m:f></m:oMath></w:p>`
			)
		)
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		tracked(editor, "Ada")
		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, pos)))
		editor.dispatch(editor.session.state.tr.deleteSelection())

		const node = editor.session.state.doc.nodeAt(pos)

		expect(node?.type).toBe(nodes.math)
		expect(await documentXml(await saved(editor, opened))).toMatch(/w:author="Bob"[^>]*><w:del w:id="\d+" w:author="Ada"/)
	})

	it("a display equation inserted at the end of the last paragraph rejects back to the document", async () => {
		const opened = await pagedEditor(docx(p("Left right")))
		const editor = opened.editor
		const before = editor.session.state.doc

		tracked(editor, "Ada")
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 11)))
		expect(await run_(editor, { type: "equation.insert", latex: "x^2", display: true })).toBe(true)
		expect(await run_(editor, { type: "review.rejectAll" })).toBe(true)
		expect(editor.session.state.doc.eq(before)).toBe(true)
	})

	it("counts changes as Word does: only those side by side of one author, kind and date are one", () => {
		const root = ommlStringTree(
			`<m:oMath><w:ins w:id="1" ${ADA}>${plainRun("a")}</w:ins><w:ins w:id="2" ${ADA}>${plainRun("b")}</w:ins>${plainRun("+")}<w:ins w:id="3" ${ADA}>${plainRun("c")}</w:ins></m:oMath>`
		) as XElement

		expect(treeChanges(root).map(change => change.id)).toEqual(["1", "3"])
	})

	it("rejecting a tracked edit of an equation of the file gives the file's bytes back", async () => {
		const bytes = docx(p("T") + `<w:p><m:oMath>${run("xy")}<m:r><m:t>+1</m:t></m:r></m:oMath></w:p>`)
		const opened = await pagedEditor(bytes)
		const editor = opened.editor

		tracked(editor, "Ada")
		selectEquation(editor.session, maths(editor.session.state.doc)[0]?.pos ?? -1)
		expect(await run_(editor, { type: "equation.edit", latex: "xz+1" })).toBe(true)
		expect(await run_(editor, { type: "review.rejectAll" })).toBe(true)
		expect(maths(editor.session.state.doc)[0]?.node.attrs["omml"]).toBeNull()
		expect(await documentXml(await saved(editor, opened))).toBe(await documentXml(bytes))
	})

	it("opens equations nested deeper than the stack goes", { timeout: 60_000 }, async () => {
		for (const [open, close] of [
			["<m:d><m:e>", "</m:e></m:d>"],
			[`<w:ins w:id="1" ${ADA}>`, "</w:ins>"]
		] as const) {
			const inner = open.repeat(20_000) + plainRun("x") + close.repeat(20_000)
			const { editor } = await pagedEditor(docx(p("a") + `<w:p><m:oMath>${inner}</m:oMath></w:p>`))

			expect(maths(editor.session.state.doc)).toHaveLength(1)
			expect(() => storyReviewIndex(editor.session).entries()).not.toThrow()
			expect(() => revisionAuthors(editor.edits.model)).not.toThrow()
		}
	})

	it("gives a new equation Word's math font and the formatting where it goes in", async () => {
		const opened = await pagedEditor(docx('<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Big</w:t></w:r></w:p>'))
		const editor = opened.editor

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 3)))
		expect(await run_(editor, { type: "equation.insert", latex: "\\frac{a}{b}", display: false })).toBe(true)

		const xml = await documentXml(await saved(editor, opened))
		const properties = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:b/><w:sz w:val="32"/></w:rPr>'

		expect(xml).toContain(`<m:ctrlPr>${properties}</m:ctrlPr>`)
		expect(xml).toContain(`<m:r>${properties}<m:t>a</m:t></m:r>`)
	})

	it("keeps the namespaces of the formatting a tracked new equation takes, through an edit", async () => {
		const opened = await pagedEditor(
			docx('<w:p><w:r><w:rPr><w:sz w:val="32"/><w14:ligatures w14:val="standardContextual"/></w:rPr><w:t>Big</w:t></w:r></w:p>')
		)
		const editor = opened.editor

		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 3)))
		tracked(editor, "Ada")
		expect(await run_(editor, { type: "equation.insert", latex: "\\frac{a}{b}", display: false })).toBe(true)
		expect(selectEquation(editor.session, maths(editor.session.state.doc)[0]?.pos ?? -1)).toBe(true)
		expect(await run_(editor, { type: "equation.edit", latex: "\\frac{a}{c}" })).toBe(true)

		const xml = await documentXml(await saved(editor, opened))

		expect(xml).toContain('<w14:ligatures w14:val="standardContextual"/>')
		expect(xml).not.toMatch(/<ligatures\b/)
	})
})

// ---- fix round 2 ---------------------------------------------------------------------------------------------

const nested = (levels: number, inner: string): string => "<m:d><m:e>".repeat(levels) + inner + "</m:e></m:d>".repeat(levels)
const FRACTION_OF_ADA =
	`<m:f><m:fPr><m:ctrlPr><w:ins w:id="7" ${ADA}><w:rPr/></w:ins></m:ctrlPr></m:fPr>` +
	`<m:num><w:ins w:id="8" ${ADA}>${plainRun("a")}</w:ins></m:num><m:den><w:ins w:id="9" ${ADA}>${plainRun("b")}</w:ins></m:den></m:f>`

describe("equations of the file deeper than readers read, or declaring their own namespaces", () => {
	it("saves typing next to an equation of the file nested deeper than readers read, which it copies as it was", async () => {
		const deep = `<m:oMath>${nested(110, plainRun("q"))}</m:oMath>`
		const opened = await pagedEditor(docx(`<w:p><w:r><w:t>ab</w:t></w:r>${deep}<w:r><w:t>cd</w:t></w:r></w:p>`))
		const editor = opened.editor

		editor.dispatch(editor.session.state.tr.insertText("X", 2))
		await settleAll(editor)

		const xml = await documentXml(await saved(editor, opened))

		expect(xml).toContain(`aXb</w:t></w:r>${deep}`)
	})

	it("refuses a tracked deletion of an equation whose deletion could not be saved, rather than dropping it", async () => {
		const deep = `<m:oMath>${nested(110, `<w:ins w:id="5" ${ADA}>${plainRun("q")}</w:ins>`)}</m:oMath>`
		const opened = await pagedEditor(docx(`<w:p><w:r><w:t>ab</w:t></w:r>${deep}<w:r><w:t>cd</w:t></w:r></w:p>`))
		const editor = opened.editor
		const before = editor.session.state.doc

		tracked(editor, "Cy")
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(before, 2, 6)))
		expect(editor.dispatch(editor.session.state.tr.deleteSelection())).toBe(false)
		expect(editor.session.state.doc.eq(before)).toBe(true)

		// Typing over the range is refused too, and the editor says why, once.
		const reasons: string[] = []

		editor.onRefused(reason => reasons.push(reason))
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(before, 2, 6)))
		expect(editor.dispatch(editor.session.state.tr.insertText("Y"))).toBe(false)
		expect(reasons).toEqual(["unsupported"])
		expect(editor.session.state.doc.eq(before)).toBe(true)

		// Text alone deletes as tracked.
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 1, 2)))
		expect(editor.dispatch(editor.session.state.tr.deleteSelection())).toBe(true)
		expect(review(editor)).toEqual(["del@text"])
	})

	it("records a deletion of an equation declaring its own namespace, and accepts and rejects it", async () => {
		const eq =
			'<m:oMath xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du">' +
			`<w:ins w:id="5" ${ADA} w16du:dateUtc="2026-01-01T10:00:00Z">${plainRun("a")}</w:ins>${plainRun("b")}</m:oMath>`

		for (const resolve of ["review.acceptAll", "review.rejectAll"] as const) {
			const opened = await pagedEditor(docx(p("T") + `<w:p>${eq}</w:p>`))
			const editor = opened.editor
			const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

			tracked(editor, "Cy")
			editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, pos)))
			editor.dispatch(editor.session.state.tr.deleteSelection())
			expect(review(editor)).toEqual(["ins@math", "del@math"])
			expect(await documentXml(await saved(editor, opened))).toMatch(/w16du:dateUtc="2026-01-01T10:00:00Z"><w:del /)
			expect(await run_(editor, { type: resolve })).toBe(true)

			const xml = await documentXml(await saved(editor, opened))

			// Accepted, all of it is deleted (the equation goes); rejected, Ada's insertion goes and b stays.
			if (resolve === "review.acceptAll") expect(xml).not.toContain("<m:oMath")
			else expect(xml).toContain(`${plainRun("b")}</m:oMath>`)
		}
	})
})

describe("tracked changes of equations whose namespaces are declared on a change or a paragraph", () => {
	it("accept, reject and delete tracked", async () => {
		const U = 'xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"'
		const change = (declared: string): string =>
			`<w:ins w:id="5" ${ADA} ${declared} w16du:dateUtc="2026-01-01T10:00:00Z">${plainRun("a")}</w:ins>${plainRun("b")}`

		for (const paragraph of [`<w:p><m:oMath>${change(U)}</m:oMath></w:p>`, `<w:p ${U}><m:oMath>${change("")}</m:oMath></w:p>`]) {
			for (const step of ["review.acceptAll", "review.rejectAll", "delete"] as const) {
				const opened = await pagedEditor(docx(p("T") + paragraph))
				const editor = opened.editor

				if (step === "delete") {
					tracked(editor, "Cy")
					editor.dispatch(
						editor.session.state.tr.setSelection(
							NodeSelection.create(editor.session.state.doc, maths(editor.session.state.doc)[0]?.pos ?? -1)
						)
					)
					expect(editor.dispatch(editor.session.state.tr.deleteSelection())).toBe(true)
					expect(review(editor)).toEqual(["ins@math", "del@math"])
				} else {
					expect(await run_(editor, { type: step })).toBe(true)
					expect(review(editor)).toEqual([])
				}

				expect(await documentXml(await saved(editor, opened))).toContain("<m:oMath")
			}
		}
	})
})

describe("untracked edits moving content that holds changes", () => {
	async function edited(equation: string, latex: string): Promise<{ markup: string; review: string[] }> {
		const opened = await pagedEditor(docx(p("T") + `<w:p><m:oMath>${equation}</m:oMath></w:p>`))
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		selectEquation(editor.session, pos)
		expect(await run_(editor, { type: "equation.edit", latex })).toBe(true)

		const node = editor.session.state.doc.nodeAt(pos) as Node

		return { markup: shown(equationTree(node, editor.session.story.part, { view: "markup" })), review: review(editor) }
	}

	it("keeps the changes of what a new object wraps", async () => {
		expect(await edited(`<w:ins w:id="5" ${ADA}>${plainRun("a")}</w:ins>${plainRun("b")}`, "\\sqrt{ab}")).toEqual({
			markup: "+ab",
			review: ["ins@math"]
		})
	})

	it("keeps the changes of what comes out of an object taken away, deletions where they were", async () => {
		const radical =
			'<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' +
			`<w:ins w:id="5" ${ADA}>${plainRun("a")}</w:ins><w:del w:id="6" ${BOB}>${plainRun("y")}</w:del>${plainRun("b")}</m:e></m:rad>`

		expect(await edited(radical, "ab")).toEqual({ markup: "-y+ab", review: ["del@math", "ins@math"] })
	})

	it("keeps another author's object moved into a new one whole", async () => {
		expect((await edited(FRACTION_OF_ADA, "\\sqrt{\\frac{a}{b}}")).review).toEqual(["ins@math"])
	})
})

describe("the LaTeX the editor gives of an equation", () => {
	it("is none (lossy) where it is longer than an edit may give", async () => {
		const { editor } = await pagedEditor(
			docx(p("T") + `<w:p><m:oMath>${plainRun("x".repeat(10_001))}</m:oMath><m:oMath>${plainRun("x".repeat(10_000))}</m:oMath></w:p>`)
		)
		const [long, limit] = maths(editor.session.state.doc)

		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, long?.pos ?? -1)))
		expect(editor.snapshot().context.equation).toMatchObject({ latex: "", lossy: true })
		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, limit?.pos ?? -1)))
		expect(editor.snapshot().context.equation).toMatchObject({ latex: "x".repeat(10_000), lossy: false })
	})
})

describe("a deletion nested in an insertion", () => {
	it("is two changes, as Word lists them, however the two interleave", async () => {
		const opened = await pagedEditor(docx(p("T") + `<w:p><m:oMath>${plainRun("z")}${FRACTION_OF_ADA}${plainRun("y")}</m:oMath></w:p>`))
		const editor = opened.editor
		const pos = maths(editor.session.state.doc)[0]?.pos ?? -1

		tracked(editor, "Bob")
		selectEquation(editor.session, pos)
		expect(await run_(editor, { type: "equation.edit", latex: "zy" })).toBe(true)
		expect(
			storyReviewIndex(editor.session)
				.entries()
				.filter(entry => entry.kind > ReviewKind.COMMENT_REFERENCE)
		).toHaveLength(2)

		const root = ommlStringTree(maths(editor.session.state.doc)[0]?.node.attrs["omml"] as string) as XElement

		expect(treeChanges(root).map(change => `${change.kind}:${change.author}`)).toEqual(["ins:Ada", "del:Bob"])
	})
})

describe("gate 2 on tracked equations", () => {
	it("leaves an equation of the source copied as it was to the source, and judges new ones", async () => {
		const deep = `<m:oMath>${nested(110, plainRun("q"))}</m:oMath>`
		const own = '<m:oMath xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"><m:r><m:t>x</m:t></m:r></m:oMath>'

		expect(await gate(deep, `<w:p>${deep}</w:p>`)).toBeUndefined()
		expect(await gate(deep)).toMatch(/nested too deep/)
		expect(await gate(`<m:oMath>${nested(110, plainRun("r"))}</m:oMath>`, `<w:p>${deep}</w:p>`)).toMatch(/nested too deep/)
		// A namespace an equation of the source declares itself is the source's for its new XML too.
		expect(await gate(own.replace("<m:t>x", "<m:t>y"), `<w:p>${own}</w:p>`)).toBeUndefined()
		expect(await gate(own.replace("<m:t>x", "<m:t>y"))).toMatch(/declares another namespace/)
	})

	it("passes Word's markup and refuses a change without an id or author", async () => {
		expect(await gate(INSERTED.replace(/^<w:p>|<\/w:p>$/g, ""))).toBeUndefined()
		// Word 365's: m:brk's m:alnAt, w14 effects in w:rPr, a namespace the part's root declares.
		expect(await gate('<m:oMath><m:r><m:rPr><m:brk m:alnAt="1"/></m:rPr><m:t>x</m:t></m:r></m:oMath>')).toBeUndefined()
		expect(await gate('<m:oMath><m:r><w:rPr><w14:glow w14:rad="1"/></w:rPr><m:t>x</m:t></m:r></m:oMath>')).toBeUndefined()
		expect(
			await gate('<m:oMath xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><m:r><m:t>x</m:t></m:r></m:oMath>')
		).toBeUndefined()
		expect(await gate('<m:oMath><m:r m:foo="1"><m:t>x</m:t></m:r></m:oMath>')).toMatch(/has attribute/)
		expect(await gate("<m:oMath><w14:glow/></m:oMath>")).toMatch(/another vocabulary/)
		expect(await gate(`<m:oMath><w:ins w:author="Ada">${run("x")}</w:ins></m:oMath>`)).toMatch(/without an id/)
		expect(await gate(`<m:oMath><w:del w:id="4">${run("x")}</w:del></m:oMath>`)).toMatch(/without an author/)
	})
})

describe.skipIf(!XMLLINT || !existsSync(SCHEMA_ARCHIVE))("tracked equations against the ECMA-376 schemas", () => {
	it("adds no validity errors", { timeout: 120_000 }, async () => {
		const validate = schemaOracle()
		const opened = await pagedEditor(FIXTURE)
		const editor = opened.editor
		const [, edited] = maths(editor.session.state.doc)

		tracked(editor, "Cy")
		selectEquation(editor.session, edited?.pos ?? -1)
		expect(await run_(editor, { type: "equation.edit", latex: "\\frac{x}{4}" })).toBe(true)
		editor.dispatch(editor.session.state.tr.setSelection(TextSelection.create(editor.session.state.doc, 3)))
		expect(
			await run_(editor, {
				type: "equation.insert",
				latex: "\\sum_{i=1}^n i \\\\ \\begin{pmatrix} 1 & 2 \\end{pmatrix}",
				display: true
			})
		).toBe(true)

		const before = validate(encodeUtf8(await documentXml(FIXTURE)))
		const after = validate(encodeUtf8(await documentXml(await saved(editor, opened))))

		expect([...after].filter(([message, count]) => (before.get(message) ?? 0) < count)).toEqual([])
		expect([...before.keys()]).toEqual([])
	})
})
