import { unzipSync } from "fflate"
import { TextSelection, type Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, gateReasons, openDocxPackage, type DocxPackage, type Story } from "@filen/office/core/docx"
import { viewOnlyProtection } from "../core/docx/package"
import { DocxEditorSession, docxSchema, openDocxEditContext, replaceAll, type DocxEditContext } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { FORMS_AFTER, FORMS_BEFORE } from "../core/docx/edit/handlers/forms"
import { REVIEW_TRANSFORMER } from "../core/docx/edit/handlers/review"
import { refusedForForms } from "../core/docx/edit/invariants/forms"
import {
	commandAllowed,
	internalViolation,
	offeredParagraphStyles,
	protectionMode,
	protectionOf,
	readOnlyExceptions
} from "../core/docx/edit/protection"
import { resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

// Document protection that allows editing within limits (ECMA-376 Part 1 §17.15.1.29): forms (content controls,
// legacy form fields and ranges open to everyone), comments (comments and open ranges), tracked changes (every
// edit recorded, the switch locked on). Read-only protection stays view-only.

const decoder = new TextDecoder()

function transformer(tr: Transaction, session: DocxEditorSession): Transaction {
	const before = FORMS_BEFORE(tr, session)

	return FORMS_AFTER(REVIEW_TRANSFORMER?.(before, session) ?? before, session)
}

interface Opened {
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	readonly session: DocxEditorSession
}

async function open(spec: SyntheticDocx, story?: (stories: readonly Story[]) => Story | undefined): Promise<Opened> {
	const opened = await openDocxPackage(bytesSource(buildDocx(spec)))

	if (!opened.ok) throw new Error(opened.reason)

	const model = await buildDocxModel(opened.package)
	const context = await openDocxEditContext(opened.package, model, { author: "Ann Lee", clock: () => Date.UTC(2026, 9, 12) })
	const chosen = story?.(model.stories)

	return {
		pkg: opened.package,
		context,
		session: new DocxEditorSession(context, { transformer, ...(chosen === undefined ? {} : { story: chosen }) })
	}
}

const protection = (edit: string, extra = ""): string => `<w:documentProtection w:edit="${edit}" w:enforcement="1"${extra}/>`

function find(session: DocxEditorSession, text: string): number {
	let at = -1

	session.state.doc.descendants((node, pos) => {
		if (at < 0 && node.isText && node.text?.includes(text) === true) at = pos + (node.text?.indexOf(text) ?? 0)

		return at < 0
	})

	if (at < 0) throw new Error(`no "${text}"`)

	return at
}

function type(session: DocxEditorSession, text: string, at: number): { applied: boolean; reason: string | undefined } {
	const tr = session.state.tr.insertText(text, at)
	const applied = session.dispatch(tr)

	return { applied, reason: refusedForForms(tr) }
}

function select(session: DocxEditorSession, from: number, to = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

const RICH =
	'<w:p><w:r><w:t xml:space="preserve">Name: </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="7"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>' +
	'<w:r><w:t>Click or tap here to enter text.</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'
const CHECK =
	'<w:p><w:sdt><w:sdtPr><w:id w:val="8"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent>' +
	'<w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t xml:space="preserve"> I agree</w:t></w:r></w:p>'
const PERMITTED = (group: string): string =>
	`<w:p><w:permStart w:id="3" ${group}/><w:r><w:t>Open text</w:t></w:r><w:permEnd w:id="3"/></w:p>`

describe("document protection: gate 0", () => {
	it("keeps read-only protection view-only and opens the limited modes", () => {
		const facts = (edit: string | undefined, enforced = true) => ({
			variant: "docx" as const,
			strict: false,
			macros: false,
			template: false,
			signatures: 0,
			documentProtection: { edit, enforced, formatting: false, hashed: true },
			writeProtection: undefined,
			glossary: false,
			attachedTemplate: false,
			subDocuments: 0,
			malformed: false
		})

		expect(gateReasons(facts("readOnly"))).toEqual(["protected"])
		expect(gateReasons(facts("someFutureMode"))).toEqual(["protected"])

		for (const edit of ["forms", "comments", "trackedChanges", "none", undefined]) expect(gateReasons(facts(edit))).toEqual([])

		expect(gateReasons(facts("readOnly", false))).toEqual([])
		expect(viewOnlyProtection({ edit: "forms", enforced: true, formatting: false, hashed: false })).toBe(false)
		expect(protectionMode("forms", true)).toBe("forms")
		expect(protectionMode("forms", false)).toBe("none")
		expect(protectionMode("readOnly", true)).toBe("none")
	})

	it("reads the mode of a document, the hash kept", async () => {
		const forms = await open({
			body: p("x"),
			settings: protection("forms", ' w:cryptProviderType="rsaAES" w:hashValue="abc=" w:saltValue="def="')
		})

		expect(protectionOf(forms.context)).toEqual({ mode: "forms", forcesTracking: false, hashed: true })
		expect(forms.session.readOnly).toBe(false)

		const readOnly = await open({ body: p("x"), settings: protection("readOnly") })

		expect(readOnly.session.snapshot().readOnlyReasons).toEqual(["protected"])
		expect(protectionOf(readOnly.context).mode).toBe("none")
	})
})

describe("document protection: forms", () => {
	it("lets only content controls change, typing at a control's edge going into it", async () => {
		const opened = await open({ body: p("Fixed text") + RICH + CHECK, settings: protection("forms") })
		const session = opened.session

		expect(type(session, "x", find(session, "Fixed") + 2)).toEqual({ applied: false, reason: "protected" })
		expect(session.dispatch(session.state.tr.delete(1, 4))).toBe(false)

		const placeholder = find(session, "Click or tap")

		expect(type(session, "Ada", placeholder + 3).applied).toBe(true)
		expect(session.state.doc.textContent).toContain("Name: Ada end")

		// Right after the control's text: still the control's.
		const end = find(session, "Ada") + 3

		expect(type(session, " L", end).applied).toBe(true)
		expect(session.state.doc.textContent).toContain("Name: Ada L end")
		select(session, find(session, "Ada L") + 1)
		expect(session.snapshot().context.control).toMatchObject({ protection: "forms", placeholder: false })

		// A checkbox changes by its command only.
		const box = find(session, "☐")

		expect(session.dispatch(session.state.tr.insertText("x", box, box + 1))).toBe(false)
		select(session, box)
		expect(session.execute({ type: "control.check" })).toBe(true)
		expect(session.state.doc.textContent).toContain("☒ I agree")

		const settings = unzipSync((await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })).bytes as Uint8Array)[
			"word/settings.xml"
		]

		expect(settings).toBeDefined()
		expect(decoder.decode(settings)).toContain(protection("forms"))
	})

	it("opens ranges an editing permission gives everyone, not one user's", async () => {
		const opened = await open({
			body: p("Fixed") + PERMITTED('w:edGrp="everyone"') + PERMITTED('w:ed="someone@example.com"').replace(/w:id="3"/g, 'w:id="4"'),
			settings: protection("forms")
		})
		const session = opened.session
		const positions: number[] = []

		session.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === "Open text") positions.push(pos)
		})

		expect(type(session, "Z", (positions[0] ?? 0) + 2).applied).toBe(true)
		expect(type(session, "Z", (positions[1] ?? 0) + 2).applied).toBe(false)
		select(session, (positions[0] ?? 0) + 1)
		expect(commandAllowed(session, "format.bold")).toBe(true)
		select(session, 2)
		expect(commandAllowed(session, "format.bold")).toBe(false)
		expect(commandAllowed(session, "control.check")).toBe(true)
		expect(commandAllowed(session, "comment.add")).toBe(false)
		expect(commandAllowed(session, "history.undo")).toBe(true)
	})
})

describe("document protection: Replace All", () => {
	for (const tracking of [false, true])
		it(`replaces the matches in ranges open to everyone and leaves the others${tracking ? " (tracked)" : ""}`, async () => {
			const { session, context } = await open({
				body: p("Fixed text") + PERMITTED('w:edGrp="everyone"'),
				settings: protection("readOnly")
			})

			context.review.tracking = tracking

			expect(replaceAll(session.state, "Fixed", "Moved")).toEqual({ refused: "unreplaceable" })

			const mixed = replaceAll(session.state, "text", "words")

			if (mixed === null || !("tr" in mixed)) throw new Error("nothing replaced")

			expect(mixed.count).toBe(1)
			expect(session.dispatch(mixed.tr)).toBe(true)
			expect(session.state.doc.child(0).textContent).toBe("Fixed text")
			expect(session.state.doc.child(1).textContent).toBe(tracking ? "Open textwords" : "Open words")
		})
})

describe("document protection: comments", () => {
	it("lets comments change and nothing else of the body outside open ranges", async () => {
		const spec: SyntheticDocx = {
			body: p("Body text") + PERMITTED('w:edGrp="everyone"'),
			comments: '<w:comment w:id="0" w:author="A"><w:p><w:r><w:t>A comment</w:t></w:r></w:p></w:comment>',
			settings: protection("comments")
		}
		const body = await open(spec)

		expect(type(body.session, "x", find(body.session, "Body") + 1)).toEqual({ applied: false, reason: "protected" })
		expect(type(body.session, "x", find(body.session, "Open") + 1).applied).toBe(true)
		expect(commandAllowed(body.session, "comment.add")).toBe(true)
		expect(commandAllowed(body.session, "format.bold")).toBe(false)
		expect(commandAllowed(body.session, "control.check")).toBe(false)

		const comment = await open(spec, stories => stories.find(story => story.kind === "comment"))

		expect(comment.session.story.story.kind).toBe("comment")
		expect(type(comment.session, "!", find(comment.session, "A comment") + 9).applied).toBe(true)
		expect(commandAllowed(comment.session, "format.bold")).toBe(true)
	})
})

describe("document protection: tracked changes", () => {
	it("records every edit and keeps the switch and accepting or rejecting changes locked", async () => {
		const opened = await open({ body: p("Some text"), settings: protection("trackedChanges") })
		const session = opened.session

		// With the integration, the switch is on from the start; without it, from the first edit.
		expect(type(session, "New ", 1).applied).toBe(true)
		expect(opened.context.review.tracking).toBe(true)

		const node = session.state.doc.nodeAt(1)

		expect(node?.marks.some(mark => mark.type === docxSchema.marks.insertion)).toBe(true)

		for (const command of ["review.track", "review.accept", "review.reject", "review.acceptAll", "review.rejectAll"] as const)
			expect(commandAllowed(session, command)).toBe(false)

		expect(commandAllowed(session, "format.bold")).toBe(true)
		expect(commandAllowed(session, "comment.add")).toBe(true)
	})
})

describe("document protection: commands", () => {
	it("disables what the mode does not allow in the snapshot and refuses it", async () => {
		const opened = await open({ body: p("Fixed text") + RICH, settings: protection("forms") })
		const session = opened.session

		select(session, find(session, "Fixed") + 1)
		expect(session.snapshot().enabled["format.bold"]).toBe(false)
		expect(session.execute({ type: "format.bold" })).toBe(false)

		const tracked = await open({ body: p("x"), settings: protection("trackedChanges") })

		expect(tracked.context.review.tracking).toBe(true)
	})

	it("routes document commands through the mode: comments in comments mode, none in forms mode", async () => {
		for (const [edit, allowed] of [
			["comments", true],
			["forms", false]
		] as const) {
			const { editor, context } = await pagedEditor(buildDocx({ body: p("Commented text"), settings: protection(edit) }))

			context.identity.author = "Ann Lee"
			editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 9)))
			expect(editor.snapshot().enabled["comment.add"]).toBe(allowed)
			expect(await editor.execute({ type: "comment.add", text: "Why?" })).toBe(allowed)
			editor.dispose()
		}
	})
})

describe("document protection: review fixes", () => {
	it("opens only the columns a permission names (w:colFirst, w:colLast) and only to everyone", async () => {
		const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
			`<w:tr>${cell("A1")}${cell("B1")}</w:tr><w:tr>${cell("A2")}${cell("B2").replace("B2</w:t></w:r></w:p>", 'B2</w:t></w:r><w:permEnd w:id="5"/></w:p>')}</w:tr></w:tbl>`
		const { session } = await open({
			body: p("Fixed") + '<w:permStart w:id="5" w:edGrp="everyone" w:colFirst="1" w:colLast="1"/>' + table + p("After"),
			settings: protection("forms")
		})

		expect(type(session, "x", find(session, "A1") + 1).applied).toBe(false)
		expect(type(session, "y", find(session, "B1") + 1).applied).toBe(true)
		expect(type(session, "z", find(session, "A2") + 1).applied).toBe(false)
		expect(type(session, "w", find(session, "B2") + 1).applied).toBe(true)

		const editors = await open({ body: PERMITTED('w:edGrp="editors"'), settings: protection("forms") })

		expect(type(editors.session, "Z", find(editors.session, "Open") + 1).applied).toBe(false)
	})

	it("keeps a protected paragraph whole: no paragraph comes into a run-level control", async () => {
		const { session } = await open({ body: p("Fixed") + RICH.replace("<w:showingPlcHdr/>", ""), settings: protection("forms") })

		expect(session.dispatch(session.state.tr.split(find(session, "tap")))).toBe(false)
		expect(session.state.doc.childCount).toBe(2)
	})

	it("refuses formatting inside a control under forms protection as the format commands are", async () => {
		const { session } = await open({ body: p("Fixed") + RICH, settings: protection("forms") })
		const at = find(session, "Click")

		expect(session.dispatch(session.state.tr.addMark(at, at + 5, docxSchema.marks.bold.create({ value: true })))).toBe(false)
		expect(type(session, "Z", at + 1).applied).toBe(true)
	})

	it("leaves sections with form protection off editable", async () => {
		const body =
			p("Free section text") +
			'<w:p><w:pPr><w:sectPr><w:formProt w:val="0"/><w:type w:val="continuous"/></w:sectPr></w:pPr></w:p>' +
			p("Form section") +
			"<w:sectPr><w:formProt/></w:sectPr>"
		const { session } = await open({ body, settings: protection("forms") })

		expect(type(session, "X", find(session, "Free") + 1).applied).toBe(true)
		expect(type(session, "X", find(session, "Form") + 1).applied).toBe(false)
	})

	// A custom XML wrapper is kept as a locked block holding the paragraph that ends its section.
	const lockedBreak = (formProt: string): string =>
		`<w:customXml w:element="part"><w:p><w:pPr><w:sectPr>${formProt}<w:type w:val="continuous"/></w:sectPr></w:pPr><w:r><w:t>Held</w:t></w:r></w:p></w:customXml>`

	it("ends a section at a locked block holding its break", async () => {
		const protectedFirst = await open({
			body: p("First section") + lockedBreak("") + p("Second section") + '<w:sectPr><w:formProt w:val="0"/></w:sectPr>',
			settings: protection("forms")
		})
		let session = protectedFirst.session

		expect(session.state.doc.child(1).type).toBe(docxSchema.nodes.locked_block)
		expect(type(session, "X", find(session, "First") + 1).applied).toBe(false)
		expect(type(session, "X", find(session, "Second") + 1).applied).toBe(true)

		session = (
			await open({
				body:
					p("First section") +
					lockedBreak('<w:formProt w:val="0"/>') +
					p("Second section") +
					"<w:sectPr><w:formProt/></w:sectPr>",
				settings: protection("forms")
			})
		).session
		expect(type(session, "X", find(session, "First") + 1).applied).toBe(true)
		expect(type(session, "X", find(session, "Second") + 1).applied).toBe(false)
	})

	it("ends no section at a locked table holding a break in a cell", async () => {
		const cell = '<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr><w:r><w:t>Cell</w:t></w:r></w:p>'
		const { session } = await open({
			body:
				p("Before table") +
				`<w:customXml w:element="part"><w:tbl><w:tr><w:tc>${cell}</w:tc></w:tr></w:tbl></w:customXml>` +
				p("After table") +
				'<w:sectPr><w:formProt w:val="0"/></w:sectPr>',
			settings: protection("forms")
		})

		expect(session.state.doc.child(1).type).toBe(docxSchema.nodes.locked_block)
		expect(type(session, "X", find(session, "Before") + 1).applied).toBe(true)
		expect(type(session, "X", find(session, "After") + 1).applied).toBe(true)
	})

	it("refuses direct formatting under enforced formatting restrictions", async () => {
		const { session } = await open({ body: p("Some text"), settings: '<w:documentProtection w:formatting="1" w:enforcement="1"/>' })

		select(session, 1, 5)
		expect(commandAllowed(session, "format.bold")).toBe(false)
		expect(commandAllowed(session, "align.center")).toBe(false)
		expect(commandAllowed(session, "style.set")).toBe(true)
	})

	it("edits only the ranges a read-only document opens to everyone", async () => {
		const { session, context } = await open({ body: p("Fixed") + PERMITTED('w:edGrp="everyone"'), settings: protection("readOnly") })

		expect(context.gate).toEqual([])
		expect(protectionOf(context).mode).toBe("readOnly")
		expect(type(session, "Z", find(session, "Open") + 1).applied).toBe(true)
		expect(type(session, "Z", find(session, "Fixed") + 1).applied).toBe(false)
		select(session, find(session, "Fixed") + 1)
		expect(commandAllowed(session, "comment.add")).toBe(false)
	})

	it("finds ranges open to everyone in a read-only document", async () => {
		const opened = await open({ body: p("Fixed") + PERMITTED('w:edGrp="everyone"'), settings: protection("readOnly") })
		const closed = await open({ body: p("Fixed") + PERMITTED('w:ed="someone@example.com"'), settings: protection("readOnly") })

		expect(readOnlyExceptions(opened.context.model)).toBe(true)
		expect(readOnlyExceptions(closed.context.model)).toBe(false)
	})
})

describe("document protection: what reaches beyond the selection", () => {
	const TRACKED =
		'<w:p><w:r><w:t xml:space="preserve">Fixed </w:t></w:r><w:ins w:id="9" w:author="X" w:date="2026-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>'

	it("refuses document-wide commands with the caret in an open range, in every limited mode", async () => {
		for (const mode of ["readOnly", "forms", "comments"]) {
			const { session } = await open({ body: p("Fixed") + PERMITTED('w:edGrp="everyone"') + TRACKED, settings: protection(mode) })

			select(session, find(session, "Open") + 2)
			expect(commandAllowed(session, "format.bold")).toBe(true)

			for (const type of [
				"review.acceptAll",
				"review.rejectAll",
				"review.accept",
				"page.setup",
				"insert.sectionBreak",
				"field.updateAll",
				"toc.insert",
				"note.insertFootnote",
				"header.edit"
			] as const)
				expect(commandAllowed(session, type)).toBe(false)
		}
	})

	it("finds the session's own transactions that edit outside the open ranges", async () => {
		const { session } = await open({ body: p("Fixed") + PERMITTED('w:edGrp="everyone"') + TRACKED, settings: protection("forms") })
		const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, true)

		expect(outcome.tr === null ? undefined : internalViolation(outcome.tr as Transaction, session)).toBe("protected")
		expect(outcome.tr === null ? true : session.dispatch(outcome.tr as Transaction)).toBe(false)

		const comments = await open({ body: p("Commented text"), settings: protection("comments") })
		const anchor = comments.session.state.tr.insert(2, docxSchema.nodes.comment_ref.create({ id: "0" }))

		expect(internalViolation(anchor, comments.session)).toBeUndefined()
	})

	it("enforces protection whose w:enforcement is missing, as Word does", async () => {
		const { context } = await open({ body: p("Some text"), settings: '<w:documentProtection w:edit="forms"/>' })

		expect(protectionOf(context).mode).toBe("forms")
	})

	it("refuses locked styles and table and picture formatting under formatting restrictions, offering the others", async () => {
		const styles = {
			name: "word/styles.xml",
			contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
			data:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
				'<w:latentStyles w:defLockedState="0"><w:lsdException w:name="heading 2" w:locked="1"/></w:latentStyles>' +
				'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:locked/></w:style></w:styles>'
		}
		const { session, context } = await open({
			body: p("Some text"),
			settings: '<w:documentProtection w:formatting="1" w:enforcement="1"/>',
			parts: [styles],
			relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
		})

		select(session, 2)
		expect(commandAllowed(session, "table.align")).toBe(false)
		expect(commandAllowed(session, "drawing.resize")).toBe(false)
		expect(commandAllowed(session, "table.row.insertBelow")).toBe(true)
		expect(session.execute({ type: "style.set", style: "heading1" })).toBe(false)
		expect(session.execute({ type: "style.set", style: "heading2" })).toBe(false)
		expect(session.execute({ type: "style.set", style: "heading3" })).toBe(true)
		expect(offeredParagraphStyles(context)).not.toContain("heading1")
		expect(offeredParagraphStyles(context)).not.toContain("heading2")
		expect(offeredParagraphStyles(context)).toContain("heading3")
	})
})

describe("document protection: comments mode and read-only ranges", () => {
	it("lets comment anchors through in comments mode, not bookmarks or permissions", async () => {
		const { session } = await open({
			body: '<w:p><w:bookmarkStart w:id="1" w:name="bm"/><w:r><w:t>Commented text</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
			settings: protection("comments")
		})
		const anchor = (kind: string): Transaction => session.state.tr.insert(2, docxSchema.nodes.marker.create({ kind, id: "7", src: -1 }))

		expect(internalViolation(anchor("commentRangeStart"), session)).toBeUndefined()
		expect(internalViolation(anchor("bookmarkStart"), session)).toBe("protected")
		expect(internalViolation(anchor("permissionStart"), session)).toBe("protected")
	})

	it("refuses document-wide commands in a comment's story too, and lets the track switch run from an open range of a read-only document", async () => {
		const comments = await open(
			{
				body: '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Text</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>',
				comments: '<w:comment w:id="0" w:author="A"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>',
				settings: protection("comments")
			},
			stories => stories.find(story => story.kind === "comment")
		)

		expect(comments.session.story.story.kind).toBe("comment")
		expect(commandAllowed(comments.session, "comment.edit")).toBe(true)
		expect(commandAllowed(comments.session, "page.setup")).toBe(false)

		const { session } = await open({ body: p("Fixed") + PERMITTED('w:edGrp="everyone"'), settings: protection("readOnly") })

		select(session, find(session, "Open") + 2)
		expect(commandAllowed(session, "review.track")).toBe(true)
		select(session, find(session, "Fixed") + 2)
		expect(commandAllowed(session, "review.track")).toBe(false)
	})
})

describe("document protection: the track switch", () => {
	it("turns tracking for the session only in a read-only document, keeping the file's w:trackRevisions", async () => {
		for (const on of [false, true]) {
			const bytes = buildDocx({
				body: p("Fixed") + PERMITTED('w:edGrp="everyone"'),
				settings: protection("readOnly") + (on ? "<w:trackRevisions/>" : "")
			})
			const { editor, pkg, context } = await pagedEditor(bytes)
			const session = editor.body.session

			context.identity.author = "Ann Lee"
			select(session, find(session, "Open") + 2)
			expect(await editor.execute({ type: "review.track" })).toBe(true)
			expect(context.review.tracking).toBe(!on)
			expect(type(session, "Z", find(session, "Open") + 1).applied).toBe(true)

			const settings = decoder.decode(
				unzipSync((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)["word/settings.xml"]
			)

			expect(settings.includes("<w:trackRevisions/>")).toBe(on)
			editor.dispose()
		}
	})
})

describe("document protection: tracking forced on", () => {
	it("saves a tracked-changes protected file without w:trackRevisions unedited byte for byte, and tracks its edits", async () => {
		const bytes = buildDocx({ body: p("Some text"), settings: protection("trackedChanges") })
		const opened = await openDocxPackage(bytesSource(bytes))

		if (!opened.ok) throw new Error(opened.reason)

		const model = await buildDocxModel(opened.package)
		const context = await openDocxEditContext(opened.package, model, { author: "Ann Lee", clock: () => Date.UTC(2026, 9, 12) })
		const session = new DocxEditorSession(context, { transformer })

		expect(context.review.tracking).toBe(true)

		const unedited = await saveDocx({ pkg: opened.package, context, sessions: [session] })

		expect(unedited.changedParts).toEqual([])
		expect(type(session, "Z", 2).applied).toBe(true)

		const result = (await saveDocx({ pkg: opened.package, context, sessions: [session] })).bytes as Uint8Array
		const saved = unzipSync(result)
		const reopened = await openDocxPackage(bytesSource(result))

		if (!reopened.ok) throw new Error(reopened.reason)

		// Reopened, the protection forces tracking again.
		expect((await openDocxEditContext(reopened.package, await buildDocxModel(reopened.package))).review.tracking).toBe(true)

		expect(decoder.decode(saved["word/document.xml"])).toContain("<w:ins ")
		expect(decoder.decode(saved["word/settings.xml"])).not.toContain("trackRevisions")
	})
})
