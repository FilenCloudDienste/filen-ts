import { unzipSync } from "fflate"
import { Fragment } from "prosemirror-model"
import { NodeSelection, TextSelection, type Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { buildDocxModel, openDocxPackage, type DocxPackage } from "@filen/office/core/docx"
import {
	DocxEditorSession,
	docxSchema,
	openDocxEditContext,
	parseDocxEditorCommand,
	replaceAll,
	type DocxEditContext
} from "@filen/office/core/docx/edit"
import { prepareDocxSave, saveDocx } from "@filen/office/core/docx/write"
import { boundControls } from "../core/docx/forms/binding"
import { controlOf, prefixMappings, simpleBinding, sourceControl, type ControlState } from "../core/docx/forms/controls"
import { formatControlDate, parseControlDate } from "../core/docx/forms/dates"
import { datePicture } from "../core/docx/fields/evaluate"
import { boundIndex } from "../core/docx/forms/positions"
import { formChecks } from "../core/docx/write/checks/forms"
import { parseXml } from "@filen/office/core/xml"
import { FORMS_AFTER, FORMS_BEFORE, shortDatePicture } from "../core/docx/edit/handlers/forms"
import { REVIEW_TRANSFORMER } from "../core/docx/edit/handlers/review"
import { resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { markCommand } from "../core/docx/edit/invariants/index"
import { NO_SOURCE } from "../core/docx/edit/schema"
import { storySessionOf } from "../core/docx/forms/sessions"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"
import { formOps } from "./fuzz/ops/forms"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"

// Content controls and legacy form fields: reading w:sdtPr, form commands, placeholders, locks, data binding,
// repeating sections, new controls, the writer's splices and Gate 2's checks.

const nodes = docxSchema.nodes
const decoder = new TextDecoder()

// The forms transformers around tracked changes, as handlers/index.ts registers them.
function transformer(tr: Transaction, session: DocxEditorSession): Transaction {
	return FORMS_AFTER(REVIEW_TRANSFORMER?.(FORMS_BEFORE(tr, session), session) ?? FORMS_BEFORE(tr, session), session)
}

interface Opened {
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	readonly session: DocxEditorSession
}

async function open(source: SyntheticDocx | Uint8Array, author?: string): Promise<Opened> {
	const opened = await openDocxPackage(bytesSource(source instanceof Uint8Array ? source : buildDocx(source)))

	if (!opened.ok) throw new Error(opened.reason)

	const model = await buildDocxModel(opened.package)
	const context = await openDocxEditContext(
		opened.package,
		model,
		author === undefined ? {} : { author, clock: () => Date.UTC(2026, 9, 12) }
	)

	return { pkg: opened.package, context, session: new DocxEditorSession(context, { transformer }) }
}

async function save(opened: Opened): Promise<Uint8Array> {
	return (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [opened.session] })).bytes as Uint8Array
}

function part(bytes: Uint8Array, name: string): string {
	const entry = unzipSync(bytes)[name]

	if (entry === undefined) throw new Error(`no ${name}`)

	return decoder.decode(entry)
}

function find(session: DocxEditorSession, text: string): number {
	let at = -1

	session.state.doc.descendants((node, pos) => {
		if (at < 0 && node.isText && node.text?.includes(text) === true) at = pos + (node.text?.indexOf(text) ?? 0)

		return at < 0
	})

	if (at < 0) throw new Error(`no "${text}"`)

	return at
}

// Where the last text node holding `text` has it.
function findLast(session: DocxEditorSession, text: string): number {
	let at = -1

	session.state.doc.descendants((node, pos) => {
		if (node.isText && node.text?.includes(text) === true) at = pos + node.text.lastIndexOf(text)
	})

	if (at < 0) throw new Error(`no "${text}"`)

	return at
}

function select(session: DocxEditorSession, from: number, to = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function control(session: DocxEditorSession) {
	return session.snapshot().context.control
}

function run(command: object, session: DocxEditorSession): boolean {
	const parsed = parseDocxEditorCommand(command)

	if (parsed === undefined) throw new Error(`invalid ${JSON.stringify(command)}`)

	return session.execute(parsed)
}

const CHECKBOX = (checked: boolean, extra = ""): string =>
	`<w:sdt><w:sdtPr><w:tag w:val="agree"/><w:id w:val="101"/>${extra}<w14:checkbox><w14:checked w14:val="${checked ? "1" : "0"}"/>` +
	'<w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>' +
	`</w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hint="eastAsia"/></w:rPr><w:t>${checked ? "☒" : "☐"}</w:t></w:r></w:sdtContent></w:sdt>`

const LIST = (kind: "dropDownList" | "comboBox", shown: string, placeholder = false): string =>
	`<w:sdt><w:sdtPr><w:alias w:val="Fruit"/><w:id w:val="102"/>${placeholder ? "<w:showingPlcHdr/>" : ""}<w:${kind}>` +
	'<w:listItem w:value="Choose an item."/><w:listItem w:displayText="Apple" w:value="A"/><w:listItem w:displayText="Pear" w:value="P"/>' +
	`</w:${kind}></w:sdtPr><w:sdtContent><w:r>${placeholder ? '<w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr>' : ""}<w:t>${shown}</w:t></w:r></w:sdtContent></w:sdt>`

const DATE_BLOCK =
	'<w:sdt><w:sdtPr><w:id w:val="103"/><w:showingPlcHdr/><w:date><w:dateFormat w:val="d MMMM yyyy"/><w:lid w:val="en-GB"/>' +
	'<w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date></w:sdtPr><w:sdtContent>' +
	'<w:p><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click or tap to enter a date.</w:t></w:r></w:p></w:sdtContent></w:sdt>'

const TEXT_PLACEHOLDER = (lock = "", extra = ""): string =>
	`<w:sdt><w:sdtPr><w:id w:val="104"/>${lock === "" ? "" : `<w:lock w:val="${lock}"/>`}<w:placeholder><w:docPart w:val="DefaultPlaceholder_-1854013440"/></w:placeholder>` +
	`<w:showingPlcHdr/>${extra}</w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click or tap here to enter text.</w:t></w:r></w:sdtContent></w:sdt>`

const PLACEHOLDER_STYLE =
	'<w:style w:type="character" w:styleId="PlaceholderText"><w:name w:val="Placeholder Text"/><w:rPr><w:color w:val="808080"/></w:rPr></w:style>'

const STYLES = {
	name: "word/styles.xml",
	contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
	data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${PLACEHOLDER_STYLE}</w:styles>`
}

const STYLED = { parts: [STYLES], relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }] }

function inParagraph(inner: string): string {
	return `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r>${inner}<w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>`
}

describe("content controls: reading", () => {
	it("reads checkbox, list, date, binding, lock, placeholder and repeating section properties", async () => {
		const { session } = await open({
			body:
				inParagraph(CHECKBOX(true)) +
				inParagraph(LIST("dropDownList", "Apple")) +
				DATE_BLOCK +
				inParagraph(
					TEXT_PLACEHOLDER(
						"sdtLocked",
						'<w:dataBinding w:prefixMappings="xmlns:ns0=\'urn:x\'" w:xpath="/ns0:a[1]/ns0:b[2]" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/><w:text w:multiLine="1"/>'
					)
				)
		})
		const part = session.story.part
		const infos = Array.from({ length: part.sdts.count }, (_, row) => sourceControl(part, part.sdts.item[row] ?? -1))

		expect(infos.map(info => info.type)).toEqual(["checkbox", "dropDownList", "date", "plainText"])
		expect(infos[0]?.checkbox).toEqual({
			checked: true,
			checkedChar: 0x2612,
			checkedFont: "MS Gothic",
			uncheckedChar: 0x2610,
			uncheckedFont: "MS Gothic"
		})
		expect(infos[1]?.items).toEqual([
			// Value-only, as Word writes its first entry: kept so when written again.
			{ text: "Choose an item.", value: "Choose an item.", valueOnly: true },
			{ text: "Apple", value: "A" },
			{ text: "Pear", value: "P" }
		])
		expect(infos[2]?.date).toEqual({ iso: null, format: "d MMMM yyyy", lid: "en-GB", calendar: "gregorian", storeAs: "dateTime" })
		expect(infos[2]?.showingPlaceholder).toBe(true)
		expect(infos[3]).toMatchObject({ lock: "sdtLocked", multiLine: true, docPart: "DefaultPlaceholder_-1854013440" })
		expect(simpleBinding(infos[3]?.binding ?? { xpath: "", prefixMappings: "", storeItemID: "" })).toEqual({
			store: "11111111-2222-3333-4444-555555555555",
			steps: [
				{ uri: "urn:x", local: "a", index: 1 },
				{ uri: "urn:x", local: "b", index: 2 }
			],
			key: "11111111-2222-3333-4444-555555555555|{urn:x}a[1]/{urn:x}b[2]"
		})
	})

	it("takes only absolute element paths as bindings it updates", () => {
		const binding = (xpath: string, mappings = "xmlns:ns0='urn:x'") =>
			simpleBinding({ xpath, prefixMappings: mappings, storeItemID: "{11111111-2222-3333-4444-555555555555}" })

		expect(binding("/ns0:a/ns0:b[3]")?.steps.map(step => step.index)).toEqual([1, 3])
		expect(binding("/a[1]/b[1]", "")?.steps.map(step => step.uri)).toEqual(["", ""])
		for (const complex of ["position()<last()-1", "//ns0:a", "/ns0:a[@x='1']", "/ns0:a/text()", "/ns1:a", "/ns0:a/@b", "/ns0:a[0]"])
			expect(binding(complex)).toBeUndefined()
		expect(simpleBinding({ xpath: "/a[1]", prefixMappings: "", storeItemID: "not-a-guid" })).toBeUndefined()
		expect([...prefixMappings("xmlns:ns0='urn:a' xmlns:ns1=\"urn:b\" ")]).toEqual([
			["ns0", "urn:a"],
			["ns1", "urn:b"]
		])
	})
})

describe("content controls: dates", () => {
	it("formats Word date pictures in the control's language and calendar", () => {
		expect(formatControlDate("2026-10-12", "d MMMM yyyy", "en-GB")).toBe("12 October 2026")
		expect(formatControlDate("2026-03-05", "M/d/yyyy", "en-US")).toBe("3/5/2026")
		expect(formatControlDate("2026-03-05", "dd.MM.yy", "de-DE")).toBe("05.03.26")
		expect(formatControlDate("2026-10-12", "dddd, MMMM dd, yyyy", "en-US")).toBe("Monday, October 12, 2026")
		expect(formatControlDate("2026-10-12", "ddd d MMM", "fr-FR")).toBe(
			`${new Intl.DateTimeFormat("fr-FR", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 12)))} 12 ${new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 12)))}`
		)
		expect(formatControlDate("2026-10-12", "'Day' d 'of' MMMM", "en-US")).toBe("Day 12 of October")
		expect(formatControlDate("2026-10-12", "h:mm AM/PM", "en-US")).toBe("12:00 AM")
		expect(formatControlDate("2026-10-12", "yyyy", "ko-KR", "korea")).toBe("4359")
		expect(formatControlDate("2026-10-12", null, "en-US")).toBe("10/12/2026")
		expect(formatControlDate("2026-10-12", "d/M/yyyy", "not a tag!")).toBe("12/10/2026")
	})
})

describe("content controls: commands", () => {
	it("toggles a checkbox with its glyph and font, writes w14:checked and undoes", async () => {
		const opened = await open({ body: inParagraph(CHECKBOX(false)) })
		const session = opened.session

		select(session, find(session, "☐"))
		expect(control(session)).toMatchObject({ kind: "control", type: "checkbox", checked: false, tag: "agree", locked: null })
		expect(session.snapshot().enabled["control.check"]).toBe(true)
		expect(run({ type: "control.check" }, session)).toBe(true)
		expect(control(session)?.checked).toBe(true)
		expect(find(session, "☒")).toBeGreaterThan(0)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain('<w14:checked w14:val="1"/>')
		expect(xml).toContain("<w:t>☒</w:t>")
		expect(xml).toContain('<w:id w:val="101"/>')

		expect(run({ type: "history.undo" }, session)).toBe(true)
		expect(find(session, "☐")).toBeGreaterThan(0)
		expect(control(session)?.checked).toBe(false)
	})

	it("does not let typing change a checkbox, a drop-down list or locked content", async () => {
		const { session } = await open({
			body: inParagraph(CHECKBOX(false)) + inParagraph(LIST("dropDownList", "Apple")) + inParagraph(TEXT_PLACEHOLDER("contentLocked"))
		})

		const box = find(session, "☐")

		expect(session.dispatch(session.state.tr.insertText("x", box, box + 1))).toBe(false)
		// Next to it is outside it.
		expect(session.dispatch(session.state.tr.insertText("x", box + 1))).toBe(true)

		for (const text of ["Apple", "Click or tap"]) {
			const at = find(session, text) + 1

			expect(session.dispatch(session.state.tr.insertText("x", at))).toBe(false)
		}

		// Formatting locked content is editing it too; formatting a checkbox is not.
		const locked = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.addMark(locked, locked + 5, docxSchema.marks.bold.create({ value: true })))).toBe(false)

		expect(session.dispatch(session.state.tr.addMark(box, box + 1, docxSchema.marks.bold.create({ value: true })))).toBe(true)
	})

	it("keeps a control locked against deletion, and deletes an unlocked one with the text around it", async () => {
		const { session } = await open({ body: inParagraph(TEXT_PLACEHOLDER("sdtLocked")) + inParagraph(TEXT_PLACEHOLDER()) })
		const first = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.delete(first - 3, first + 35))).toBe(false)

		const second = session.state.doc.textContent.lastIndexOf("Click or tap")

		expect(second).toBeGreaterThan(0)

		const at = (() => {
			let found = -1

			session.state.doc.descendants((node, pos) => {
				if (node.isText && node.text?.startsWith("Click or tap") === true) found = pos
			})

			return found
		})()

		expect(session.dispatch(session.state.tr.delete(at - 3, at + 34))).toBe(true)
		expect(session.state.doc.textContent.match(/Click or tap/g)?.length).toBe(1)
	})

	it("chooses a list entry: its display text, w:lastValue, the placeholder gone", async () => {
		const opened = await open({ body: inParagraph(LIST("dropDownList", "Choose an item.", true)), ...STYLED })
		const session = opened.session

		select(session, find(session, "Choose") + 2)
		expect(control(session)).toMatchObject({ type: "dropDownList", placeholder: true, title: "Fruit", value: null })
		expect(run({ type: "control.choose", value: "missing" }, session)).toBe(false)
		expect(run({ type: "control.choose", value: "P" }, session)).toBe(true)
		expect(control(session)).toMatchObject({ value: "P", placeholder: false })

		const pear = find(session, "Pear")
		const marks = session.state.doc.nodeAt(pear)?.marks.map(mark => mark.type.name) ?? []

		expect(marks).not.toContain("char_style")

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain('<w:dropDownList w:lastValue="P">')
		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).toContain("<w:t>Pear</w:t>")

		// The value-only entry shows the placeholder again.
		select(session, find(session, "Pear") + 1)
		expect(run({ type: "control.choose", value: "Choose an item." }, session)).toBe(true)
		expect(control(session)).toMatchObject({ placeholder: true, value: null })
	})

	it("sets a block date control's date, formatted as its picture says, and clears it, keeping the last date", async () => {
		const opened = await open({ body: DATE_BLOCK, ...STYLED })
		const session = opened.session

		select(session, find(session, "Click") + 2)
		expect(control(session)).toMatchObject({ type: "date", placeholder: true, dateFormat: "d MMMM yyyy" })
		expect(run({ type: "control.date", iso: "2026-10-12" }, session)).toBe(true)
		expect(session.state.doc.textContent).toBe("12 October 2026")
		expect(control(session)).toMatchObject({ date: "2026-10-12", placeholder: false })

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain('<w:date w:fullDate="2026-10-12T00:00:00Z">')
		expect(xml).not.toContain("showingPlcHdr")

		select(session, 3)
		expect(run({ type: "control.clear" }, session)).toBe(true)
		expect(session.state.doc.textContent).toBe("Click or tap to enter a date.")
		// The last date stays as w:fullDate under the placeholder.
		expect(control(session)).toMatchObject({ date: "2026-10-12", placeholder: true })

		const cleared = part(await save(opened), "word/document.xml")

		expect(cleared).toContain('<w:date w:fullDate="2026-10-12T00:00:00Z">')
		expect(cleared).toContain("showingPlcHdr")
	})
})

describe("content controls: placeholders", () => {
	it("turns a placeholder into text once part of it is deleted (w:showingPlcHdr and its style go)", async () => {
		const opened = await open({ body: inParagraph(TEXT_PLACEHOLDER()), ...STYLED })
		const session = opened.session
		const at = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.delete(at, at + 6))).toBe(true)
		expect(session.state.doc.textContent).toBe("Before or tap here to enter text. after")
		expect(control((select(session, find(session, "or tap") + 1), session))).toMatchObject({ placeholder: false })
		expect(session.state.doc.nodeAt(find(session, "or tap"))?.marks.some(mark => mark.type.name === "char_style")).toBe(false)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")
		expect(xml).toContain("or tap here to enter text.")
	})

	it("gives an equation put in for a placeholder no placeholder style", async () => {
		const opened = await open({ body: inParagraph(TEXT_PLACEHOLDER()), ...STYLED })
		const session = opened.session

		select(session, find(session, "Click") + 2)
		expect(run({ type: "equation.insert", latex: "x", display: false }, session)).toBe(true)
		expect(control(session)).toMatchObject({ placeholder: false })

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")
		expect(xml).toContain('<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t>x</m:t></m:r>')
	})

	it("turns a placeholder into text once part of it is deleted as a tracked change", async () => {
		const opened = await open({ body: inParagraph(TEXT_PLACEHOLDER()), ...STYLED }, "Ada")
		const session = opened.session

		opened.context.review.tracking = true

		const at = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.delete(at + 1, at + 5))).toBe(true)
		expect(control((select(session, find(session, "or tap") + 1), session))).toMatchObject({ placeholder: false })

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")
		expect(xml).toMatch(/<w:del [^>]*><w:r>(?:<w:rPr><\/w:rPr>)?<w:delText>lick<\/w:delText><\/w:r><\/w:del>/)
	})

	it("turns a placeholder into text once a comment is anchored in it", async () => {
		const opened = await pagedEditor(buildDocx({ body: inParagraph(TEXT_PLACEHOLDER()), ...STYLED }))
		const { editor } = opened

		opened.context.identity.author = "Ada"
		opened.context.identity.now = () => Date.UTC(2026, 9, 12)

		const session = editor.session
		const at = find(session, "Click or tap")

		select(session, at + 1, at + 5)
		expect(await editor.execute({ type: "comment.add", text: "Which?" })).toBe(true)
		expect(session.state.doc.textContent).toContain("Click or tap here to enter text.")
		expect(control((select(session, find(session, "or tap") + 1), session))).toMatchObject({ placeholder: false })

		const xml = part(
			(await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })).bytes as Uint8Array,
			"word/document.xml"
		)

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")
		expect(xml).toContain("<w:commentReference")
	})

	it("turns a block control's placeholder into text once part of it is deleted, and shows it again once emptied", async () => {
		const block =
			'<w:sdt><w:sdtPr><w:id w:val="105"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:p><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr>' +
			"<w:t>Click or tap here to enter text.</w:t></w:r></w:p></w:sdtContent></w:sdt>"
		const opened = await open({ body: block, ...STYLED })
		const session = opened.session
		const at = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.delete(at, at + 6))).toBe(true)
		expect(control((select(session, find(session, "or tap") + 1), session))).toMatchObject({ placeholder: false })

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")

		const rest = find(session, "or tap")

		expect(session.dispatch(session.state.tr.delete(rest, rest + "or tap here to enter text.".length))).toBe(true)
		expect(session.state.doc.textContent).toBe("Click or tap here to enter text.")
		expect(control((select(session, find(session, "Click") + 1), session))).toMatchObject({ placeholder: true })
	})

	it("types over a placeholder (its text, style and flag go) and brings it back once emptied", async () => {
		const opened = await open({ body: inParagraph(TEXT_PLACEHOLDER()), ...STYLED })
		const session = opened.session
		const at = find(session, "Click or tap") + 5

		expect(session.dispatch(session.state.tr.insertText("Ada", at))).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Ada after")
		expect(control((select(session, find(session, "Ada") + 1), session))).toMatchObject({ placeholder: false })

		const ada = find(session, "Ada")

		expect(session.state.doc.nodeAt(ada)?.marks.some(mark => mark.type.name === "char_style")).toBe(false)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).not.toContain("showingPlcHdr")
		expect(xml).not.toContain("PlaceholderText")

		expect(session.dispatch(session.state.tr.delete(ada, ada + 3))).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Click or tap here to enter text. after")

		const back = find(session, "Click or tap")

		expect(session.state.doc.nodeAt(back)?.marks.find(mark => mark.type.name === "char_style")?.attrs["styleId"]).toBe(
			"PlaceholderText"
		)
		select(session, back + 1)
		expect(control(session)).toMatchObject({ placeholder: true })

		const again = part(await save(opened), "word/document.xml")

		expect(again).toContain("<w:showingPlcHdr/>")
		expect(again).toContain('<w:rStyle w:val="PlaceholderText"/>')
	})

	it("empties a block control to its placeholder, and removes a temporary control once typed into", async () => {
		const temporary = TEXT_PLACEHOLDER("", "<w:temporary/>").replace(
			/<w:sdtContent>(.*)<\/w:sdtContent>/,
			"<w:sdtContent><w:p>$1</w:p></w:sdtContent>"
		)
		const opened = await open({ body: p("x") + temporary + p("y"), ...STYLED })
		const session = opened.session
		const at = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.insertText("Typed", at, at + 31))).toBe(true)
		expect(session.state.doc.child(1).type).toBe(nodes.paragraph)
		expect(session.state.doc.textContent).toBe("xTypedy")
		expect(part(await save(opened), "word/document.xml")).not.toContain("<w:sdt>")
	})

	it("adds Word's Placeholder Text style to a document without it, for new controls and placeholders brought back", async () => {
		const opened = await open({
			body: p("Name ") + inParagraph(TEXT_PLACEHOLDER().replace('<w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr>', ""))
		})
		const session = opened.session

		expect(opened.context.styles.byName("Placeholder Text", "character")).toBeUndefined()

		// Typed over and emptied: the placeholder comes back in Word's style.
		const at = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.insertText("Ada", at, at + 32))).toBe(true)
		expect(session.dispatch(session.state.tr.delete(find(session, "Ada"), find(session, "Ada") + 3))).toBe(true)
		expect(
			session.state.doc.nodeAt(find(session, "Click or tap"))?.marks.find(mark => mark.type.name === "char_style")?.attrs["styleId"]
		).toBe("PlaceholderText")

		// A new control shows its placeholder in it too.
		select(session, find(session, "Name") + 5)
		expect(run({ type: "control.insert", kind: "plainText" }, session)).toBe(true)

		const bytes = await save(opened)
		const styles = part(bytes, "word/styles.xml")

		// docx4j__loadAndSave.docx (Word 16): basedOn the default character style, priority 99, semi-hidden.
		expect(styles).toContain(
			'<w:style w:type="character" w:styleId="PlaceholderText"><w:name w:val="Placeholder Text"/><w:uiPriority w:val="99"/>' +
				'<w:semiHidden/><w:rPr><w:color w:val="666666"/></w:rPr></w:style>'
		)
		expect(part(bytes, "word/document.xml").match(/<w:rStyle w:val="PlaceholderText"\/>/g)).toHaveLength(2)

		// Typed over again: the style goes from the content, and from the save once nothing uses it.
		const back = find(session, "Click or tap")

		expect(session.dispatch(session.state.tr.insertText("Bo", back, back + 32))).toBe(true)
		expect(session.state.doc.nodeAt(find(session, "Bo"))?.marks.some(mark => mark.type.name === "char_style")).toBe(false)
	})

	it("keeps a document's own placeholder style", async () => {
		const opened = await open({ body: p("Name "), ...STYLED })
		const session = opened.session

		select(session, find(session, "Name") + 5)
		expect(run({ type: "control.insert", kind: "plainText" }, session)).toBe(true)

		const bytes = await save(opened)

		expect(part(bytes, "word/styles.xml").match(/w:styleId="PlaceholderText"/g)).toHaveLength(1)
		expect(part(bytes, "word/styles.xml")).toContain('<w:color w:val="808080"/>')
	})
})

describe("content controls: data binding", () => {
	const ITEM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root xmlns="urn:x"><name>Old</name><other>keep</other></root>'
	const PROPS =
		'<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{11111111-2222-3333-4444-555555555555}" ' +
		'xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>'
	const BOUND = (xpath: string, text: string, id: string): string =>
		`<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="${xpath}" ` +
		`w:storeItemID="{11111111-2222-3333-4444-555555555555}"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>${text}</w:t></w:r></w:sdtContent></w:sdt>`
	const spec = (body: string): SyntheticDocx => ({
		body,
		relationships: [{ id: "rIdX", type: "customXml", target: "../customXml/item1.xml" }],
		parts: [
			{ name: "customXml/item1.xml", data: ITEM },
			{
				name: "customXml/itemProps1.xml",
				contentType: "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
				data: PROPS
			},
			{
				name: "customXml/_rels/item1.xml.rels",
				data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>'
			}
		]
	})

	it("writes a simple bound control's new value into its custom XML node", async () => {
		const opened = await open(spec(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "5"))))
		const session = opened.session
		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("New"))).toBe(true)

		const bytes = await save(opened)

		expect(part(bytes, "customXml/item1.xml")).toBe(ITEM.replace("<name>Old</name>", "<name>New</name>"))
		expect(
			boundControls(session.story.part, session.state.doc).get(
				"s" +
					String(
						session.state.doc
							.child(0)
							.child(1)
							.marks.find(mark => mark.type.name === "content_control")?.attrs["src"]
					)
			)?.value
		).toBe("New")
	})

	it("locks a control bound by a path the editor does not update", async () => {
		const { session } = await open(spec(inParagraph(BOUND("/ns0:root[1]/ns0:name[last()]", "Old", "6"))))
		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(control(session)?.locked).toBe("bound")
		expect(session.dispatch(session.state.tr.insertText("New"))).toBe(false)
		expect(session.dispatch(session.state.tr.insertText("N", at + 1))).toBe(false)
	})

	it("shows an edited value in the story's other controls bound to the node", async () => {
		const opened = await open(
			spec(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")) + inParagraph(BOUND("/ns0:root/ns0:name", "Old", "8")))
		)
		const session = opened.session
		const first = find(session, "Old")

		select(session, first, first + 3)
		expect(session.dispatch(session.state.tr.insertText("One"))).toBe(true)
		expect(session.state.doc.textContent).toBe("Before One afterBefore One after")

		expect(part(await save(opened), "customXml/item1.xml")).toContain("<name>One</name>")
		expect(run({ type: "history.undo" }, session)).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Old afterBefore Old after")
	})

	const withHeader = (body: string, header: string): SyntheticDocx => ({
		...spec(body + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>'),
		headers: { rIdH: header }
	})

	it("keeps controls bound to one node in different stories alike as either is edited, undo included", async () => {
		const opened = await open(
			withHeader(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")), inParagraph(BOUND("/ns0:root/ns0:name", "Old", "8")))
		)
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = opened.session
		const header = new DocxEditorSession(opened.context, { transformer, story })
		const at = find(body, "Old")

		select(body, at, at + 3)
		expect(body.dispatch(body.state.tr.insertText("One"))).toBe(true)
		expect(header.state.doc.textContent).toBe("Before One after")
		// The header's change is no undo step of its own.
		expect(run({ type: "history.undo" }, header)).toBe(false)

		const there = find(header, "One")

		select(header, there, there + 3)
		expect(header.dispatch(header.state.tr.insertText("Two"))).toBe(true)
		expect(body.state.doc.textContent).toBe("Before Two after")

		const bytes = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, header] })).bytes as Uint8Array

		expect(part(bytes, "customXml/item1.xml")).toContain("<name>Two</name>")
		expect(part(bytes, "word/document.xml")).toContain("<w:t>Two</w:t>")
		expect(part(bytes, "word/header1.xml")).toContain("<w:t>Two</w:t>")

		// Undoing the header's edit takes the body back with it; the body's own undo then takes both to the start.
		expect(run({ type: "history.undo" }, header)).toBe(true)
		expect(body.state.doc.textContent).toBe("Before One after")
		expect(run({ type: "history.undo" }, body)).toBe(true)
		expect(header.state.doc.textContent).toBe("Before Old after")
		expect(body.state.doc.textContent).toBe("Before Old after")
		expect(run({ type: "history.redo" }, body)).toBe(true)
		expect(header.state.doc.textContent).toBe("Before One after")

		// Emptied: the placeholder in both.
		const one = find(body, "One")

		expect(body.dispatch(body.state.tr.delete(one, one + 3))).toBe(true)
		expect(header.state.doc.textContent).toBe(body.state.doc.textContent)
	})

	it("keeps a comment's range end and reference in a bound control whose value another control changes", async () => {
		const binding =
			'<w:dataBinding w:prefixMappings="xmlns:ns0=\'urn:x\'" w:xpath="/ns0:root/ns0:name" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/>'
		const anchored =
			'<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Before </w:t></w:r>' +
			`<w:sdt><w:sdtPr><w:id w:val="9"/>${binding}<w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Old</w:t></w:r>` +
			'<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:sdtContent></w:sdt></w:p>'
		const opened = await open({
			...spec(anchored + inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7"))),
			comments: '<w:comment w:id="0" w:author="Bo" w:date="2020-01-01T00:00:00Z"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>'
		})
		const session = opened.session
		const at = findLast(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("New"))).toBe(true)

		const anchors: string[] = []

		session.state.doc.descendants(node => {
			if (node.type === nodes.marker || node.type === nodes.comment_ref) anchors.push(String(node.attrs["kind"] ?? "reference"))
		})
		expect(session.state.doc.textContent).toBe("Before NewBefore New after")
		expect(anchors).toEqual(["commentRangeStart", "commentRangeEnd", "reference"])
		expect(part(await save(opened), "word/document.xml")).toContain('<w:commentRangeEnd w:id="0"/>')
	})

	it("passes a bound value once to a span another story holds under two controls bound to the node", async () => {
		const binding =
			'<w:dataBinding w:prefixMappings="xmlns:ns0=\'urn:x\'" w:xpath="/ns0:root/ns0:name" w:storeItemID="{11111111-2222-3333-4444-555555555555}"/>'
		const nested =
			`<w:sdt><w:sdtPr><w:id w:val="9"/>${binding}<w:text/></w:sdtPr><w:sdtContent>` +
			`<w:sdt><w:sdtPr><w:id w:val="10"/>${binding}<w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Old</w:t></w:r></w:sdtContent></w:sdt>` +
			"</w:sdtContent></w:sdt>"
		const opened = await open(withHeader(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")), inParagraph(nested)))
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = opened.session
		const header = new DocxEditorSession(opened.context, { transformer, story })
		const at = find(body, "Old")

		select(body, at, at + 3)
		expect(body.dispatch(body.state.tr.insertText("Kraków"))).toBe(true)
		expect(header.state.doc.textContent).toBe("Before Kraków after")
	})

	it("keeps a pasted copy of a bound control showing the node's value, and in step with the original", async () => {
		const opened = await open(spec(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")) + p("End")))
		const session = opened.session
		const first = session.state.doc.child(0)

		// Typed over first, then the paragraph pasted (with the control in it) after the last one.
		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("Ann"))).toBe(true)

		const copy = session.state.doc.child(0)

		select(session, find(session, "End") + 3)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, copy.nodeSize)))).toBe(true)
		expect(first.textContent).toBe("Before Old after")
		expect(session.state.doc.textContent).toBe("Before Ann afterEndBefore Ann after")

		// Either one edited: the other follows.
		const pos = findLast(session, "Ann")

		expect(pos).toBeGreaterThan(find(session, "Ann"))
		select(session, pos, pos + 3)
		expect(session.dispatch(session.state.tr.insertText("Bob"))).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Bob afterEndBefore Bob after")
		expect(part(await save(opened), "customXml/item1.xml")).toContain("<name>Bob</name>")
	})

	it("shows a bound value in a block control holding a table as one paragraph, as Word refreshes it", async () => {
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>' +
			'<w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>' +
			p("Old") +
			"</w:tc></w:tr></w:tbl>"
		const block = (id: string, content: string): string =>
			`<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="/ns0:root[1]/ns0:name[1]" ` +
			`w:storeItemID="{11111111-2222-3333-4444-555555555555}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`
		const opened = await open(spec(block("11", table) + p("x") + block("12", p("Old"))))
		const session = opened.session
		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("New"))).toBe(true)

		const last = session.state.doc.child(2)

		expect(last.textContent).toBe("New")
		expect(last.childCount).toBe(1)

		// Typed in the plain one: the table holder becomes one paragraph showing it.
		const there = findLast(session, "New")

		select(session, there, there + 3)
		expect(session.dispatch(session.state.tr.insertText("Two"))).toBe(true)
		expect(session.state.doc.child(0).firstChild?.type.name).toBe("paragraph")
		expect(session.state.doc.textContent).toBe("TwoxTwo")

		const saved = await save(opened)

		expect(part(saved, "word/document.xml")).not.toContain("<w:tbl>")
		expect(part(saved, "customXml/item1.xml")).toContain("<name>Two</name>")
	})

	it("passes on a tracked edit's value untracked, and the value its rejection leaves", async () => {
		const opened = await open(
			withHeader(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")), inParagraph(BOUND("/ns0:root/ns0:name", "Old", "8"))),
			"Ann Author"
		)
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = opened.session
		const header = new DocxEditorSession(opened.context, { transformer, story })
		const at = find(body, "Old")

		opened.context.review.tracking = true
		select(body, at, at + 3)
		expect(body.dispatch(body.state.tr.insertText("New"))).toBe(true)
		expect(header.state.doc.textContent).toBe("Before New after")

		let revisions = 0

		header.state.doc.descendants(node => {
			if (node.marks.some(mark => mark.type.name === "insertion" || mark.type.name === "deletion")) revisions++
		})
		expect(revisions).toBe(0)

		const outcome = resolveChanges(body, storyReviewIndex(body), { all: true }, false)

		expect(outcome.tr).not.toBeNull()
		body.dispatch(outcome.tr as Transaction)
		expect(body.state.doc.textContent).toBe("Before Old after")
		expect(header.state.doc.textContent).toBe("Before Old after")
	})

	it("passes a bound value to the stories a paged editor has not opened yet", async ({ skip }) => {
		const bytes = buildDocx(
			withHeader(inParagraph(BOUND("/ns0:root[1]/ns0:name[1]", "Old", "7")), inParagraph(BOUND("/ns0:root/ns0:name", "Old", "8")))
		)
		const { editor, context, pkg } = await pagedEditor(bytes)
		const story = context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")
		// The editor hosts its stories' sessions (paged/editor.ts hostStories) once integrated.
		if (storySessionOf(context, story.index) === undefined) skip()

		const session = editor.session
		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("One"))).toBe(true)
		expect(editor.storySession(story.index)?.state.doc.textContent).toBe("Before One after")
		expect(editor.execute({ type: "history.undo" })).toBe(true)
		expect(editor.storySession(story.index)?.state.doc.textContent).toBe("Before Old after")
		expect(editor.execute({ type: "history.redo" })).toBe(true)
		await settleAll(editor)

		const saved = (await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array

		expect(part(saved, "word/header1.xml")).toContain("<w:t>One</w:t>")
		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved))
		editor.dispose()
	})
})

describe("content controls: pasted copies", () => {
	it("keeps a pasted copy of a block control a control with its properties and state, under no id of its own", async () => {
		const opened = await open({ body: DATE_BLOCK + p("End"), ...STYLED })
		const session = opened.session

		select(session, find(session, "Click") + 2)
		expect(run({ type: "control.date", iso: "2026-10-12" }, session)).toBe(true)

		const block = session.state.doc.child(0)

		select(session, find(session, "End") + 3)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, block.nodeSize)))).toBe(true)
		select(session, findLast(session, "October") + 1)
		expect(control(session)).toMatchObject({ type: "date", date: "2026-10-12", placeholder: false })
		expect(run({ type: "control.date", iso: "2026-11-01" }, session)).toBe(true)
		expect(session.state.doc.textContent).toBe("12 October 2026End1 November 2026")

		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w:sdt>/g)).toHaveLength(2)
		expect(xml.match(/<w:id w:val="103"\/>/g)).toHaveLength(1)
		expect(xml).toContain('<w:date w:fullDate="2026-10-12T00:00:00Z">')
		expect(xml).toContain('<w:date w:fullDate="2026-11-01T00:00:00Z">')
	})

	it("keeps a pasted copy of a run-level control one control of its own", async () => {
		const opened = await open({ body: inParagraph(LIST("dropDownList", "Apple")) })
		const session = opened.session
		const paragraph = session.state.doc.child(0)

		select(session, paragraph.nodeSize - 1)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, paragraph.nodeSize)))).toBe(true)

		const copy = findLast(session, "Apple")

		select(session, copy + 1)
		expect(control(session)).toMatchObject({ type: "dropDownList" })
		expect(run({ type: "control.choose", value: "P" }, session)).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Apple afterBefore Pear after")

		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w:dropDownList/g)).toHaveLength(2)
		expect(xml.match(/<w:id w:val="102"\/>/g)).toHaveLength(1)
	})
})

describe("content controls: repeating sections", () => {
	const SECTION =
		'<w:sdt><w:sdtPr><w:id w:val="200"/><w15:repeatingSection/></w:sdtPr><w:sdtContent>' +
		'<w:sdt><w:sdtPr><w:id w:val="201"/><w15:repeatingSectionItem/></w:sdtPr><w:sdtContent>' +
		p("Item text") +
		'<w:p><w:r><w:t xml:space="preserve">Name: </w:t></w:r>' +
		TEXT_PLACEHOLDER() +
		"</w:p></w:sdtContent></w:sdt></w:sdtContent></w:sdt>"

	it("adds an item as a copy of the current one and removes it again", async () => {
		const opened = await open({ body: p("x") + SECTION + p("y"), ...STYLED })
		const session = opened.session

		select(session, find(session, "Item text") + 2)
		expect(session.snapshot().enabled["control.item.add"]).toBe(true)
		expect(session.snapshot().enabled["control.item.remove"]).toBe(false)
		expect(run({ type: "control.item.add" }, session)).toBe(true)
		expect(session.state.doc.child(1).childCount).toBe(2)

		// The copy's text control is a control: typing replaces its placeholder.
		const second = session.state.doc.textContent.lastIndexOf("Click")
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (node.isText && node.text?.startsWith("Click") === true) at = pos
		})
		expect(second).toBeGreaterThan(0)
		expect(session.dispatch(session.state.tr.insertText("Bo", at + 2))).toBe(true)

		// The copy's inline control is written new.
		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w15:repeatingSectionItem\/>/g)?.length).toBe(2)
		expect(xml.match(/<w:id w:val="201"\/>/g)?.length).toBe(1)
		expect(xml).toContain("<w:t>Bo</w:t>")

		const reopened = await open(await save(opened))

		expect(reopened.session.state.doc.textContent).toContain("Name: Bo")

		select(session, find(session, "Bo"))
		expect(session.snapshot().enabled["control.item.remove"]).toBe(true)
		expect(run({ type: "control.item.remove" }, session)).toBe(true)
		expect(session.state.doc.child(1).childCount).toBe(1)
		expect(session.snapshot().enabled["control.item.remove"]).toBe(false)
	})

	it("inserts a repeating section around the selected paragraphs", async () => {
		const opened = await open({ body: p("one") + p("two") + p("three") })
		const session = opened.session

		select(session, find(session, "one"), find(session, "two") + 2)
		expect(run({ type: "control.insert", kind: "repeatingSection" }, session)).toBe(true)
		expect(session.state.doc.child(0).type).toBe(nodes.sdt)
		expect(controlOf(session.story.part, session.state.doc.child(0))?.type).toBe("repeatingSection")

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toMatch(
			/<w:sdtPr><w:id w:val="-?\d+"\/><w15:repeatingSection\/><\/w:sdtPr><w:sdtContent><w:sdt><w:sdtPr><w:id w:val="-?\d+"\/><w15:repeatingSectionItem\/>/
		)

		const reopened = await open(await save(opened))
		const info = controlOf(reopened.session.story.part, reopened.session.state.doc.child(0))

		expect(info?.type).toBe("repeatingSection")
	})
})

describe("content controls: tracked changes", () => {
	it("records a checkbox change as one control holding the deleted and inserted glyphs", async () => {
		const opened = await open({ body: inParagraph(CHECKBOX(false)), settings: "<w:trackRevisions/>" }, "Ann Lee")
		const session = opened.session

		select(session, find(session, "☐"))
		expect(run({ type: "control.check" }, session)).toBe(true)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w:sdt>/g)?.length).toBe(1)
		expect(xml).toMatch(/<w:del [^>]*><w:r>.*<w:delText>☐<\/w:delText>.*<w:ins [^>]*><w:r>.*<w:t>☒<\/w:t>/)
	})
})

const PICTURE_XML =
	'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1"/>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="a.png"/>' +
	'<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm>' +
	'<a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData>' +
	"</a:graphic></wp:inline></w:drawing></w:r>"
const PICTURE_CONTROL = `<w:p><w:sdt><w:sdtPr><w:id w:val="300"/><w:picture/></w:sdtPr><w:sdtContent>${PICTURE_XML}</w:sdtContent></w:sdt></w:p>`

describe("content controls: tracked form commands", () => {
	it("gives all of a checkbox's content the state the latest toggle wrote, deleted glyphs included", async () => {
		const box =
			'<w:p><w:r><w:t xml:space="preserve">Check: </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="5"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox>' +
			"</w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt></w:p>"
		const opened = await open({ body: p("x") + box }, "Ann Lee")
		const session = opened.session
		const states = (): string[] => {
			const out: string[] = []

			session.state.doc.child(1).forEach(child => {
				for (const mark of child.marks) if (mark.type.name === "content_control") out.push(JSON.stringify(mark.attrs["state"]))
			})

			return out
		}

		opened.context.review.tracking = true

		for (const checked of [true, false, true]) {
			select(session, session.state.doc.child(0).nodeSize + 9)
			expect(run({ type: "control.check" }, session)).toBe(true)
			expect(new Set(states())).toEqual(new Set([JSON.stringify({ checked, placeholder: false })]))
		}

		await save(opened)
	})
})

describe("content controls: pictures", () => {
	it("lets a picture control's picture be replaced (Change Picture) and nothing typed into it", async () => {
		const { session } = await open({ body: PICTURE_CONTROL, settings: '<w:documentProtection w:edit="forms" w:enforcement="1"/>' })
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (node.type === nodes.drawing) at = pos
		})

		const drawing = session.state.doc.nodeAt(at)

		if (drawing === null) throw new Error("no picture")

		select(session, at)
		expect(control(session)).toMatchObject({ type: "picture" })
		expect(session.dispatch(session.state.tr.insertText("x", at, at + 1))).toBe(false)
		expect(session.dispatch(session.state.tr.replaceWith(at, at + 1, drawing))).toBe(true)
	})
})

describe("content controls: Gate 2", () => {
	it("refuses a checkbox whose glyph is not its state's", async () => {
		const opened = await open({ body: inParagraph(CHECKBOX(false)) })
		const session = opened.session
		const at = find(session, "☐")
		const mark = session.state.doc.nodeAt(at)?.marks.find(item => item.type.name === "content_control")

		if (mark === undefined) throw new Error("no control")

		const state: ControlState = { checked: true }
		const tr = session.state.tr
			.removeMark(at, at + 1, mark)
			.addMark(at, at + 1, docxSchema.marks.content_control.create({ ...mark.attrs, state }))

		expect(session.dispatch(markCommand(tr))).toBe(true)
		await expect(prepareDocxSave({ pkg: opened.pkg, context: opened.context, sessions: [session] })).rejects.toMatchObject({
			reason: "content"
		})
	})
})

describe("content controls: new controls", () => {
	it("inserts each kind of inline control and writes it new", async () => {
		const opened = await open({ body: p("Name ") })
		const session = opened.session
		const end = find(session, "Name") + 5

		for (const kind of ["plainText", "richText", "checkbox", "date", "comboBox"] as const) {
			select(session, end)
			expect(
				run(
					kind === "comboBox"
						? { type: "control.insert", kind, items: [{ text: "Yes", value: "Y" }] }
						: { type: "control.insert", kind },
					session
				)
			).toBe(true)
		}

		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w:sdt>/g)?.length).toBe(5)
		expect(xml).toContain("<w:text/>")
		expect(xml).toContain('<w14:checked w14:val="0"/>')
		// Word's "Choose an item." entry first.
		expect(xml).toContain(
			'<w:comboBox><w:listItem w:value="Choose an item."/><w:listItem w:displayText="Yes" w:value="Y"/></w:comboBox>'
		)
		expect(xml).toContain('<w:dateFormat w:val="M/d/yyyy"/>')

		const reopened = await open(await save(opened))
		const types: string[] = []

		reopened.session.state.doc.descendants(node => {
			for (const mark of node.marks)
				if (mark.type.name === "content_control" && !types.includes(mark.attrs["type"] as string))
					types.push(mark.attrs["type"] as string)
		})
		expect(types.sort()).toEqual(["checkbox", "comboBox", "date", "richText", "text"])
	})

	it("makes a picture control only around a selected picture", async () => {
		const { session } = await open({ body: p("x") })

		select(session, 1)
		expect(run({ type: "control.insert", kind: "picture" }, session)).toBe(false)
	})

	it("fills in legacy form fields: check box, drop-down and text", async () => {
		const field = (code: string, ffData: string, result = ""): string =>
			`<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="F"/><w:enabled/><w:calcOnExit w:val="0"/>${ffData}</w:ffData></w:fldChar></w:r>` +
			`<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
		const opened = await open({
			body:
				`<w:p>${field("FORMCHECKBOX", '<w:checkBox><w:sizeAuto/><w:default w:val="0"/></w:checkBox>')}</w:p>` +
				`<w:p>${field("FORMDROPDOWN", '<w:ddList><w:listEntry w:val="Red"/><w:listEntry w:val="Blue"/></w:ddList>')}</w:p>` +
				`<w:p>${field("FORMTEXT", "<w:textInput/>", "<w:r><w:t>old</w:t></w:r>")}</w:p>`,
			settings: '<w:documentProtection w:edit="forms" w:enforcement="1"/>'
		})
		const session = opened.session
		const fields: number[] = []

		session.state.doc.descendants((node, pos) => {
			if (node.type === nodes.field) fields.push(pos)
		})

		const at = (index: number): boolean =>
			session.dispatch(session.state.tr.setSelection(NodeSelection.create(session.state.doc, fields[index] ?? 0)))

		at(0)
		expect(control(session)).toMatchObject({ kind: "field", type: "checkbox", checked: false })
		expect(run({ type: "control.check" }, session)).toBe(true)
		at(1)
		expect(run({ type: "control.choose", value: "Blue" }, session)).toBe(true)
		at(2)
		expect(run({ type: "control.text", text: "new value" }, session)).toBe(true)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain('<w:checkBox><w:sizeAuto/><w:default w:val="0"/><w:checked w:val="1"/></w:checkBox>')
		expect(xml).toContain('<w:ddList><w:result w:val="1"/><w:listEntry w:val="Red"/>')
		expect(xml).toContain("<w:t>new value</w:t>")
		expect(xml).not.toContain("<w:t>old</w:t>")
	})

	const LEGACY_CHECKBOX =
		'<w:p><w:bookmarkStart w:id="0" w:name="Check1"/><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Check1"/><w:enabled/>' +
		'<w:calcOnExit w:val="0"/><w:helpText w:type="text" w:val="Tick &amp; go"/><w:checkBox><w:sizeAuto/><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r>' +
		'<w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
		'<w:r><w:fldChar w:fldCharType="end"/></w:r><w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve"> Agree</w:t></w:r></w:p>'

	function legacyFields(session: DocxEditorSession): number[] {
		const out: number[] = []

		session.state.doc.descendants((node, pos) => {
			if (node.type === nodes.field) out.push(pos)
		})

		return out
	}

	it("keeps a pasted copy of a legacy form field a form field, its w:ffData with it", async () => {
		const opened = await open({ body: LEGACY_CHECKBOX + p("End") })
		const session = opened.session
		const paragraph = session.state.doc.child(0)

		// The paragraph copied into the last one, as a host's paste or a drag-copy without the sanitiser does.
		select(session, find(session, "End") + 3)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, paragraph.nodeSize)))).toBe(true)

		const [original, copy] = legacyFields(session)

		if (original === undefined || copy === undefined) throw new Error("no copy")

		expect(session.state.doc.nodeAt(copy)?.attrs["src"]).toBe(NO_SOURCE)
		session.dispatch(session.state.tr.setSelection(NodeSelection.create(session.state.doc, copy)))
		// Its bookmark stays with the original: Word shows a copy's empty.
		expect(control(session)).toMatchObject({ kind: "field", type: "checkbox", checked: false, tag: null })
		expect(run({ type: "control.check" }, session)).toBe(true)
		expect(control(session)).toMatchObject({ kind: "field", checked: true })
		session.dispatch(session.state.tr.setSelection(NodeSelection.create(session.state.doc, original)))
		expect(control(session)).toMatchObject({ kind: "field", checked: false, tag: "Check1" })
	})

	it("writes a pasted legacy form field with its w:ffData, the bookmark staying with the original", async () => {
		const opened = await open({ body: LEGACY_CHECKBOX + p("End") })
		const session = opened.session
		const paragraph = session.state.doc.child(0)

		select(session, find(session, "End") + 3)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, paragraph.nodeSize)))).toBe(true)

		const copy = legacyFields(session)[1]

		if (copy === undefined) throw new Error("no copy")

		session.dispatch(session.state.tr.setSelection(NodeSelection.create(session.state.doc, copy)))
		expect(run({ type: "control.check" }, session)).toBe(true)

		const xml = part(await save(opened), "word/document.xml")

		// As Word writes pasted copies (govuk__S62A_Questionnaire, poi__form_footnotes): the same w:name, one bookmark.
		expect(xml.match(/<w:name w:val="Check1"\/>/g)).toHaveLength(2)
		expect(xml.match(/<w:bookmarkStart [^>]*w:name="Check1"/g)).toHaveLength(1)
		expect(xml).toContain(
			'<w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Check1"/><w:enabled/><w:calcOnExit w:val="0"/>' +
				'<w:helpText w:type="text" w:val="Tick &amp; go"/><w:checkBox><w:sizeAuto/><w:default w:val="0"/><w:checked w:val="1"/></w:checkBox></w:ffData></w:fldChar>'
		)

		const reopened = await open(await save(opened))
		const fields = legacyFields(reopened.session)
		const tags = fields.map(at => {
			reopened.session.dispatch(reopened.session.state.tr.setSelection(NodeSelection.create(reopened.session.state.doc, at)))

			return control(reopened.session)?.tag
		})

		// Reopened, the copy (no bookmark of its name) shows none either.
		expect(tags).toEqual(["Check1", null])
	})
})

describe("forms fuzz ops", () => {
	it("registers ops for both harnesses", () => {
		expect(formOps.some(op => op.harness === "paged")).toBe(true)
		expect(formOps.some(op => op.harness === "damage")).toBe(true)
	})
})

describe("content controls: review fixes", () => {
	const ITEM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root xmlns="urn:x"><name>Old</name><other>keep</other></root>'
	const STORE = "{11111111-2222-3333-4444-555555555555}"
	const bound = (xpath: string, text: string, id: string, kind = "<w:text/>"): string =>
		`<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="${xpath}" w:storeItemID="${STORE}"/>${kind}` +
		`</w:sdtPr><w:sdtContent><w:r><w:t>${text}</w:t></w:r></w:sdtContent></w:sdt>`
	const NAME = "/ns0:root[1]/ns0:name[1]"
	const withItem = (body: string, item = ITEM): SyntheticDocx => ({
		body,
		relationships: [{ id: "rIdX", type: "customXml", target: "../customXml/item1.xml" }],
		parts: [
			{ name: "customXml/item1.xml", data: item },
			{
				name: "customXml/itemProps1.xml",
				contentType: "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="${STORE}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`
			},
			{
				name: "customXml/_rels/item1.xml.rels",
				data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>'
			}
		]
	})
	const text = (session: DocxEditorSession): string => session.state.doc.textContent

	it("pastes into a plain text control as plain text, so controls bound to one node keep one value", async () => {
		const opened = await open(withItem(inParagraph(bound(NAME, "Old", "7")) + p("End")))
		const session = opened.session
		const paragraph = session.state.doc.child(0)

		select(session, find(session, "Old") + 1)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(0, paragraph.nodeSize)))).toBe(true)

		let controls = 0

		session.state.doc.descendants(node => {
			if (node.marks.some(mark => mark.type.name === "content_control" && mark.attrs["src"] === NO_SOURCE)) controls++
		})
		expect(controls).toBe(0)
		expect(text(session)).toBe("Before OBefore Old afterld afterEnd")
		expect(part(await save(opened), "customXml/item1.xml")).toContain("<name>OBefore Old afterld</name>")
	})

	it("takes a line break into a one-line plain text control as a space, and refuses a break alone", async () => {
		const line =
			'<w:sdt><w:sdtPr><w:id w:val="9"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Ada Lovelace</w:t></w:r></w:sdtContent></w:sdt>'
		const { session } = await open({ body: inParagraph(line) })
		const at = find(session, "Lovelace")

		expect(session.dispatch(session.state.tr.replaceWith(at, at, nodes.break.create({ type: "textWrapping" })))).toBe(false)
		expect(
			session.dispatch(
				session.state.tr.replaceWith(at, at, [
					docxSchema.text("x"),
					nodes.break.create({ type: "textWrapping" }),
					docxSchema.text("y")
				])
			)
		).toBe(true)
		expect(session.state.doc.textContent).toBe("Before Ada x yLovelace after")
	})

	it("leaves a copy pasted into a rich text control bound to its node no control of its own", async () => {
		const opened = await open(withItem(inParagraph(bound(NAME, "Old", "7", "")) + p("End")))
		const session = opened.session
		const paragraph = session.state.doc.child(0)

		select(session, find(session, "Old") + 1)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(1, paragraph.nodeSize - 1)))).toBe(true)

		const keys = new Set<string>()

		session.state.doc.descendants(node => {
			for (const mark of node.marks) if (mark.type.name === "content_control") keys.add(`${String(mark.attrs["src"])}`)
		})
		expect(keys.size).toBe(1)
		expect(text(session)).toBe("Before OBefore Old afterld afterEnd")
		expect(part(await save(opened), "customXml/item1.xml")).toContain("<name>OBefore Old afterld</name>")
	})

	it("turns Enter into a line break in a multi-line plain text control and ignores it in a one-line one", async () => {
		const line = (multi: boolean): string =>
			`<w:sdt><w:sdtPr><w:id w:val="9"/><w:text${multi ? ' w:multiLine="1"' : ""}/></w:sdtPr><w:sdtContent><w:r><w:t>Ada Lovelace</w:t></w:r></w:sdtContent></w:sdt>`

		for (const multi of [true, false]) {
			const { session } = await open({ body: inParagraph(line(multi)) })

			expect(session.dispatch(session.state.tr.split(find(session, "Lovelace")))).toBe(multi)
			expect(session.state.doc.childCount).toBe(1)

			if (multi) expect(session.state.doc.child(0).child(2).type).toBe(nodes.break)
		}
	})

	it("stores the latest edit's value in a node whose changed controls cannot agree, never a stale one", async () => {
		const checkbox =
			`<w:sdt><w:sdtPr><w:id w:val="5"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="${NAME}" w:storeItemID="${STORE}"/>` +
			'<w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt>'
		const opened = await open(
			withItem(inParagraph(bound(NAME, "true", "6")) + inParagraph(checkbox) + p("Free"), ITEM.replace("Old", "true"))
		)
		const session = opened.session
		const at = find(session, "true")

		select(session, at, at + 4)
		expect(session.dispatch(session.state.tr.insertText("Banana"))).toBe(true)
		expect(session.dispatch(session.state.tr.insertText("!", find(session, "Free")))).toBe(true)

		const bytes = await save(opened)

		expect(part(bytes, "customXml/item1.xml")).toContain("<name>Banana</name>")
		expect(part(bytes, "word/document.xml")).toContain("!Free")
	})

	it("syncs controls bound to one node after a review resolution in their story", async () => {
		const opened = await open(
			withItem(inParagraph(bound(NAME, "Old", "7")) + p("mid") + inParagraph(bound("/ns0:root/ns0:name", "Old", "8"))),
			"Ann Lee"
		)
		const session = opened.session

		opened.context.review.tracking = true

		const at = find(session, "Old")

		select(session, at, at + 3)
		expect(session.dispatch(session.state.tr.insertText("New"))).toBe(true)

		const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, false)

		expect(outcome.tr === null ? false : session.dispatch(outcome.tr as Transaction)).toBe(true)
		expect(text(session)).toBe("Before Old aftermidBefore Old after")
		expect(part(await save(opened), "customXml/item1.xml")).toContain("<name>Old</name>")
	})

	it("stores text typed into a combo box as text unless it is an entry's, and a typed date as Word reads it", async () => {
		const combo =
			`<w:sdt><w:sdtPr><w:id w:val="30"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="${NAME}" w:storeItemID="${STORE}"/>` +
			'<w:comboBox w:lastValue="A"><w:listItem w:displayText="Apple" w:value="A"/><w:listItem w:displayText="Pear" w:value="P"/></w:comboBox>' +
			"</w:sdtPr><w:sdtContent><w:r><w:t>Apple</w:t></w:r></w:sdtContent></w:sdt>"

		for (const [typed, stored] of [
			["Banana", "Banana"],
			["Pear", "P"]
		]) {
			const opened = await open(withItem(inParagraph(combo), ITEM.replace("Old", "A")))
			const at = find(opened.session, "Apple")

			select(opened.session, at, at + 5)
			expect(opened.session.dispatch(opened.session.state.tr.insertText(typed ?? ""))).toBe(true)
			expect(part(await save(opened), "customXml/item1.xml")).toContain(`<name>${stored ?? ""}</name>`)
		}

		const date =
			`<w:sdt><w:sdtPr><w:id w:val="12"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="${NAME}" w:storeItemID="${STORE}"/>` +
			'<w:date w:fullDate="2026-01-02T00:00:00Z"><w:dateFormat w:val="d MMMM yyyy"/><w:lid w:val="en-GB"/><w:storeMappedDataAs w:val="dateTime"/>' +
			'<w:calendar w:val="gregorian"/></w:date></w:sdtPr><w:sdtContent><w:r><w:t>2 January 2026</w:t></w:r></w:sdtContent></w:sdt>'

		for (const [typed, stored, fullDate] of [
			["tomorrow", "tomorrow", "2026-01-02T00:00:00Z"],
			["5 March 2026", "2026-03-05T00:00:00", "2026-03-05T00:00:00Z"]
		]) {
			const opened = await open(withItem(inParagraph(date), ITEM.replace("Old", "2026-01-02T00:00:00")))
			const at = find(opened.session, "2 January")

			select(opened.session, at, at + 14)
			expect(opened.session.dispatch(opened.session.state.tr.insertText(typed ?? ""))).toBe(true)

			const bytes = await save(opened)

			expect(part(bytes, "customXml/item1.xml")).toContain(`<name>${stored ?? ""}</name>`)
			expect(/<w:date(?: w:fullDate="([^"]*)")?>/.exec(part(bytes, "word/document.xml"))?.[1] ?? null).toBe(fullDate)
		}
	})

	it("keeps a custom XML node with child elements whole (Word maps only leaf nodes)", async () => {
		const opened = await open(withItem(inParagraph(bound("/ns0:root[1]", "OldKeep", "7"))))
		const at = find(opened.session, "OldKeep")

		select(opened.session, at, at + 7)
		expect(opened.session.dispatch(opened.session.state.tr.insertText("New"))).toBe(true)

		const bytes = await save(opened)

		expect(part(bytes, "customXml/item1.xml")).toBe(ITEM)
		expect(part(bytes, "word/document.xml")).toContain("<w:t>New</w:t>")
	})

	it("keeps controls bound to a node with child elements or to none apart from the first edit, as Word maps neither", async () => {
		for (const xpath of ["/ns0:root[1]", "/ns0:root[1]/ns0:missing[1]"]) {
			const opened = await open(withItem(inParagraph(bound(xpath, "One", "7")) + inParagraph(bound(xpath, "Two", "8"))))
			const session = opened.session
			// Edited right after open: what maps is known by then.
			const at = find(session, "One")

			select(session, at, at + 3)
			expect(session.dispatch(session.state.tr.insertText("New"))).toBe(true)
			expect(text(session)).toBe("Before New afterBefore Two after")
		}
	})

	it("wraps only text typed over a selected control into it, not a change elsewhere", async () => {
		const plain =
			'<w:sdt><w:sdtPr><w:id w:val="45"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Value</w:t></w:r></w:sdtContent></w:sdt>'
		const opened = await open({ body: inParagraph(plain) + p("Other with teh typo") })
		const session = opened.session
		const at = find(session, "Value")

		select(session, at, at + 5)

		const replaced = replaceAll(session.state, "teh", "the")

		expect(replaced !== null && "tr" in replaced && session.dispatch(replaced.tr)).toBe(true)
		expect(part(await save(opened), "word/document.xml")).toContain("<w:t>Other with the typo</w:t>")
	})

	it("appends text typed at the end of an inline control to it", async () => {
		const plain =
			'<w:sdt><w:sdtPr><w:id w:val="45"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Value</w:t></w:r></w:sdtContent></w:sdt>'
		const opened = await open({ body: inParagraph(plain) })
		const session = opened.session

		select(session, find(session, "Value") + 5)
		expect(session.dispatch(session.state.tr.insertText("X"))).toBe(true)
		expect(part(await save(opened), "word/document.xml")).toContain("<w:sdtContent><w:r><w:t>ValueX</w:t></w:r></w:sdtContent>")
	})

	it("replaces all outside locked controls and refuses changing a locked control by putting it back", async () => {
		const locked = (value: string): string =>
			`<w:sdt><w:sdtPr><w:id w:val="61"/><w:lock w:val="contentLocked"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>${value}</w:t></w:r></w:sdtContent></w:sdt>`
		const { session } = await open({
			body:
				'<w:p><w:r><w:t xml:space="preserve">foo </w:t></w:r>' +
				locked("foo") +
				'<w:r><w:t xml:space="preserve"> foo</w:t></w:r></w:p>' +
				inParagraph(CHECKBOX(false))
		})
		const replaced = replaceAll(session.state, "foo", "bar")

		expect(replaced !== null && "tr" in replaced && session.dispatch(replaced.tr)).toBe(true)
		expect(text(session)).toBe("bar foo barBefore ☐ after")
		expect(replaceAll(session.state, "☐", "☒")).toEqual({ refused: "unreplaceable" })

		const from = find(session, "bar")
		const to = findLast(session, "bar") + 3
		let changed = Fragment.empty

		session.state.doc.slice(from, to).content.forEach(node => {
			changed = changed.addToEnd(node.isText ? docxSchema.text((node.text ?? "").replace("foo", "XXX"), node.marks) : node)
		})
		expect(session.dispatch(session.state.tr.replaceWith(from, to, changed))).toBe(false)
	})

	it("formats everything around a control whose content is locked", async () => {
		const locked =
			'<w:sdt><w:sdtPr><w:id w:val="10"/><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent><w:r><w:t>Locked</w:t></w:r></w:sdtContent></w:sdt>'
		const opened = await open({ body: inParagraph(locked) + p("x") })
		const session = opened.session

		select(session, 1, session.state.doc.content.size - 1)
		expect(run({ type: "format.bold" }, session)).toBe(true)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain("<w:sdtContent><w:r><w:t>Locked</w:t></w:r></w:sdtContent>")
		expect(xml).toContain('<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">Before </w:t></w:r>')
	})

	it("pastes a partial copy of a control showing its placeholder with the whole placeholder", async () => {
		const opened = await open({ body: inParagraph(TEXT_PLACEHOLDER("", "<w:text/>")) + p("End") })
		const session = opened.session
		const at = find(session, "Click")

		select(session, find(session, "End") + 3)
		expect(session.dispatch(session.state.tr.replaceSelection(session.state.doc.slice(at + 2, at + 9)))).toBe(true)
		expect(session.state.doc.child(1).textContent).toBe("EndClick or tap here to enter text.")
	})

	it("keeps the positions of bound controls through edits as a fresh walk finds them", async () => {
		const opened = await open(
			withItem(inParagraph(bound(NAME, "Old", "7")) + p("mid") + inParagraph(bound("/ns0:root/ns0:name", "Old", "8")))
		)
		const session = opened.session
		const part = session.story.part

		boundIndex(part, session.state.doc)
		select(session, find(session, "mid") + 1)
		expect(session.dispatch(session.state.tr.split(find(session, "mid") + 1))).toBe(true)
		expect(session.dispatch(session.state.tr.insertText("Z", find(session, "Old") + 1))).toBe(true)
		expect(session.dispatch(session.state.tr.delete(1, 3))).toBe(true)

		const followed = boundIndex(part, session.state.doc)
		const fresh = boundIndex(part, session.state.doc.copy(session.state.doc.content))

		expect([...followed]).toEqual([...fresh])
		expect(text(session)).toBe("fore OZld aftermidBefore OZld after")
	})
})

describe("content controls: dates and legacy text fields", () => {
	it("names months as a date has them, eras and Buddhist years, and reads typed dates with the picture", () => {
		expect(formatControlDate("2026-10-13", "d MMMM yyyy", "ru-RU")).toBe("13 октября 2026")
		expect(formatControlDate("2026-10-13", "MMMM yyyy", "ru-RU")).toBe("октябрь 2026")
		expect(formatControlDate("2026-10-13", "ggge年M月d日", "ja-JP", "japan")).toBe("令和8年10月13日")
		expect(formatControlDate("2026-10-13", "d MMMM BBBB", "th-TH", "thai")).toBe("13 ตุลาคม 2569")
		expect(parseControlDate("Donnerstag, 5 März 2026", "dddd, d MMMM yyyy", "de-DE")).toBe("2026-03-05")
		expect(parseControlDate("13 октября 2026", "d MMMM yyyy", "ru-RU")).toBe("2026-10-13")
		expect(parseControlDate("31/2/2026", "d/M/yyyy", "en-GB")).toBeNull()
		expect(parseControlDate("tomorrow", "M/d/yyyy", "en-US")).toBeNull()
	})

	it("names months as date fields do, English as Word writes it, and shows AM/PM upper case", () => {
		expect(formatControlDate("2026-09-13", "d MMM yyyy", "en-GB")).toBe("13 Sep 2026")
		expect(formatControlDate("2026-10-13", "h:mm am/pm", "en-US")).toBe("12:00 AM")
		expect(datePicture(new Date(2026, 9, 13, 12), "d MMMM yyyy", "ru-RU")).toBe("13 октября 2026")
		expect(datePicture(new Date(2026, 9, 13, 12), "MMMM yyyy", "ru-RU")).toBe(formatControlDate("2026-10-13", "MMMM yyyy", "ru-RU"))
	})

	it("keeps a legacy form field's formatting when it is filled in, tracked or not", async () => {
		const field =
			'<w:p><w:r><w:t xml:space="preserve">Name </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Text1"/><w:enabled/>' +
			'<w:calcOnExit w:val="0"/><w:textInput/></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>old</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

		for (const tracked of [false, true]) {
			const opened = await open({ body: p("x") + field }, "Ann Lee")
			const session = opened.session
			let pos = -1

			opened.context.review.tracking = tracked
			session.state.doc.descendants((node, at) => {
				if (node.type === nodes.field) pos = at
			})
			select(session, pos, pos + 1)
			expect(run({ type: "format.bold" }, session)).toBe(true)
			select(session, pos)
			expect(run({ type: "control.text", text: "filled" }, session)).toBe(true)

			const xml = part(await save(opened), "word/document.xml")

			expect(xml).toContain("filled")
			expect(xml.match(/<w:b\/>/g)?.length).toBe(5)
		}
	})

	it("fills in legacy text fields as their type and format say", async () => {
		const field = (input: string): string =>
			'<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Text1"/><w:enabled/><w:calcOnExit w:val="0"/>' +
			`<w:textInput>${input}</w:textInput></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>` +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const cases: [string, string, string | null][] = [
			['<w:type w:val="number"/><w:format w:val="#,##0.00"/>', "1234.5", "1,234.50"],
			['<w:type w:val="number"/>', "abc", null],
			['<w:type w:val="calculated"/>', "7", null],
			['<w:type w:val="currentDate"/>', "7", null],
			['<w:maxLength w:val="3"/><w:format w:val="UPPERCASE"/>', "a😀bc", "A😀B"],
			['<w:type w:val="date"/><w:format w:val="dd/MM/yyyy"/>', "5/3/2026", "05/03/2026"]
		]

		for (const [input, typed, result] of cases) {
			const { session } = await open({ body: p("x") + field(input) })
			let pos = -1

			session.state.doc.descendants((node, at) => {
				if (node.type === nodes.field) pos = at
			})
			select(session, pos)
			expect(run({ type: "control.text", text: typed }, session)).toBe(result !== null)

			let shown = ""

			session.state.doc.descendants(node => {
				if (node.type === nodes.field) shown = String(node.attrs["result"])
			})
			expect(shown).toBe(result ?? "12")
		}
	})
})

describe("content controls: Gate 2 ids", () => {
	it("refuses a control id a part holds twice unless the source already did", async () => {
		const sdt = (id: string): string =>
			`<w:p><w:sdt><w:sdtPr><w:id w:val="${id}"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>v</w:t></w:r></w:sdtContent></w:sdt></w:p>`
		const check = formChecks[0]
		const root = (body: string): string =>
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`

		for (const [source, written, ok] of [
			[sdt("7") + sdt("8"), sdt("7") + sdt("7") + sdt("8"), false],
			[sdt("7") + sdt("7"), sdt("7") + sdt("7"), true],
			[sdt("7"), sdt("7") + sdt("9"), true]
		] as const) {
			const { session, context } = await open({ body: source })
			const checked = {
				name: "word/document.xml",
				part: session.story.part,
				document: parseXml(new TextEncoder().encode(root(written))),
				skeleton: false
			}
			const run = (): unknown => check?.part?.({ context } as never, checked)

			if (ok) expect(run).not.toThrow()
			else expect(run).toThrow(/content control id 7 appears 2 times/)
		}
	})
})

describe("content controls: made controls under tracking", () => {
	it("writes a made control split around a tracked change with its w:id once", async () => {
		const opened = await open({ body: p("Hello world") }, "Ann Lee")
		const session = opened.session

		select(session, 3)
		expect(run({ type: "control.insert", kind: "dropDownList", items: [{ text: "Apple", value: "A" }] }, session)).toBe(true)
		opened.context.review.tracking = true
		select(session, find(session, "Choose") + 2)
		expect(run({ type: "control.choose", value: "A" }, session)).toBe(true)

		const xml = part(await save(opened), "word/document.xml")

		expect(xml.match(/<w:sdt>/g)?.length).toBe(2)
		expect(xml.match(/<w:id w:val=/g)?.length).toBe(1)
	})
})

describe("content controls: copies in another part", () => {
	it("keeps a checkbox copied into the header a checkbox there", async () => {
		const opened = await open({
			body: inParagraph(CHECKBOX(false)) + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("Head") }
		})
		const story = opened.context.model.stories.find(candidate => candidate.kind === "header")
		const header = new DocxEditorSession(opened.context, { transformer, ...(story === undefined ? {} : { story }) })

		select(header, find(header, "Head") + 4)
		expect(
			header.dispatch(header.state.tr.replaceSelection(opened.session.state.doc.slice(0, opened.session.state.doc.child(0).nodeSize)))
		).toBe(true)
		select(header, find(header, "☐"))
		expect(control(header)?.type).toBe("checkbox")
		expect(run({ type: "control.check" }, header)).toBe(true)

		const xml = part(
			(await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [opened.session, header] })).bytes as Uint8Array,
			"word/header1.xml"
		)

		expect(xml).toContain('w14:checked w14:val="1"')
		expect(xml).toContain("☒")
	})

	it("keeps a bound control copied into the header bound, both stories showing one value", async () => {
		const item = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root xmlns="urn:x"><name>Old</name></root>'
		const store = "{11111111-2222-3333-4444-555555555555}"
		const opened = await open({
			body:
				inParagraph(
					`<w:sdt><w:sdtPr><w:id w:val="7"/><w:dataBinding w:prefixMappings="xmlns:ns0='urn:x'" w:xpath="/ns0:root[1]/ns0:name[1]" w:storeItemID="${store}"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Old</w:t></w:r></w:sdtContent></w:sdt>`
				) + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("Head") },
			relationships: [{ id: "rIdX", type: "customXml", target: "../customXml/item1.xml" }],
			parts: [
				{ name: "customXml/item1.xml", data: item },
				{
					name: "customXml/itemProps1.xml",
					contentType: "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
					data: `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="${store}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`
				},
				{
					name: "customXml/_rels/item1.xml.rels",
					data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>'
				}
			]
		})
		const body = opened.session
		const story = opened.context.model.stories.find(candidate => candidate.kind === "header")
		const header = new DocxEditorSession(opened.context, { transformer, ...(story === undefined ? {} : { story }) })

		select(header, find(header, "Head") + 4)
		expect(header.dispatch(header.state.tr.replaceSelection(body.state.doc.slice(0, body.state.doc.child(0).nodeSize)))).toBe(true)

		const at = find(header, "Old")

		select(header, at, at + 3)
		expect(header.dispatch(header.state.tr.insertText("New"))).toBe(true)
		expect(body.state.doc.textContent).toBe("Before New after")

		const bytes = (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, header] })).bytes as Uint8Array

		expect(part(bytes, "customXml/item1.xml")).toContain("<name>New</name>")
		expect(part(bytes, "word/header1.xml")).toContain('w:xpath="/ns0:root[1]/ns0:name[1]"')
	})
})

describe("content controls: cost of undo", () => {
	it("does not walk content an undo puts back for copies of another part's controls", async () => {
		let body = ""

		for (let k = 0; k < 200; k++) body += p(`Paragraph ${String(k)} lorem ipsum`)

		const opened = await open({ body }, "Ann Lee")
		const session = opened.session

		opened.context.review.tracking = true
		select(session, 1, session.state.doc.content.size - 1)
		expect(session.dispatch(session.state.tr.deleteSelection())).toBe(true)

		// Who walks a fragment's content during the undo.
		const walks: string[] = []
		const original = Fragment.prototype.descendants

		Fragment.prototype.descendants = function (this: Fragment, f: Parameters<Fragment["descendants"]>[0]) {
			walks.push(new Error().stack ?? "")
			original.call(this, f)
		}

		try {
			expect(run({ type: "history.undo" }, session)).toBe(true)
		} finally {
			Fragment.prototype.descendants = original
		}

		expect(walks.filter(stack => stack.includes("noteForeignCopies"))).toEqual([])
	})
})

describe("content controls: list entries and new controls' defaults", () => {
	it("changes a source drop-down's entries, keeping the choice while its entry stays", async () => {
		const opened = await open({ body: inParagraph(LIST("dropDownList", "Apple")), ...STYLED })
		const session = opened.session

		select(session, find(session, "Apple") + 2)
		// The file names no last value: the entry shown is found by its text.
		expect(control(session)).toMatchObject({ value: null, placeholder: false })
		expect(
			run(
				{
					type: "control.items",
					items: [
						{ text: "Apple", value: "A" },
						{ text: "Plum", value: "Plum" }
					]
				},
				session
			)
		).toBe(true)
		expect(control(session)?.items).toEqual([
			{ text: "Apple", value: "A" },
			{ text: "Plum", value: "Plum" }
		])
		expect(control(session)).toMatchObject({ value: "A", placeholder: false })

		const xml = part(await save(opened), "word/document.xml")

		expect(xml).toContain(
			'<w:dropDownList w:lastValue="A"><w:listItem w:displayText="Apple" w:value="A"/><w:listItem w:displayText="Plum" w:value="Plum"/></w:dropDownList>'
		)
		expect(xml).not.toContain("Pear")

		const reopened = await open(await save(opened))

		select(reopened.session, find(reopened.session, "Apple") + 2)
		expect(control(reopened.session)?.items.map(item => item.text)).toEqual(["Apple", "Plum"])
	})

	it("shows the placeholder again when the chosen entry is removed, and undoes", async () => {
		const opened = await open({ body: inParagraph(LIST("dropDownList", "Apple")), ...STYLED })
		const session = opened.session

		select(session, find(session, "Apple") + 2)
		expect(
			run(
				{
					type: "control.items",
					items: [
						{ text: "Choose an item.", value: "Choose an item." },
						{ text: "Pear", value: "P" }
					]
				},
				session
			)
		).toBe(true)
		expect(control(session)).toMatchObject({ placeholder: true, value: null })
		expect(session.state.doc.textContent).toContain("Choose an item.")

		const xml = part(await save(opened), "word/document.xml")

		// The value-only entry stays value-only, as Word wrote it.
		expect(xml).toContain(
			'<w:dropDownList><w:listItem w:value="Choose an item."/><w:listItem w:displayText="Pear" w:value="P"/></w:dropDownList>'
		)
		expect(xml).toContain("showingPlcHdr")

		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(control(session)).toMatchObject({ value: null, placeholder: false })
		expect(control(session)?.items.length).toBe(3)
	})

	it("changes a new drop-down's entries in its definition, refusing duplicates and other controls", async () => {
		const opened = await open({ body: p("Pick ") })
		const session = opened.session

		select(session, find(session, "Pick") + 5)
		expect(run({ type: "control.insert", kind: "dropDownList", items: [{ text: "One", value: "1" }] }, session)).toBe(true)
		expect(control(session)?.items.map(item => item.text)).toEqual(["Choose an item.", "One"])
		expect(
			run(
				{
					type: "control.items",
					items: [
						{ text: "One", value: "1" },
						{ text: "Two", value: "2" }
					]
				},
				session
			)
		).toBe(true)
		expect(control(session)?.items.map(item => item.text)).toEqual(["One", "Two"])
		expect(part(await save(opened), "word/document.xml")).toContain(
			'<w:dropDownList><w:listItem w:displayText="One" w:value="1"/><w:listItem w:displayText="Two" w:value="2"/></w:dropDownList>'
		)
		expect(
			parseDocxEditorCommand({
				type: "control.items",
				items: [
					{ text: "Same", value: "a" },
					{ text: "Same", value: "b" }
				]
			})
		).toBeUndefined()

		// A command no parser saw is refused as well: two entries with one value, or one text.
		expect(
			session.execute({
				type: "control.items",
				items: [
					{ text: "One", value: "1" },
					{ text: "Uno", value: "1" }
				]
			})
		).toBe(false)
		expect(
			session.execute({
				type: "control.items",
				items: [
					{ text: "One", value: "1" },
					{ text: "One", value: "2" }
				]
			})
		).toBe(false)
		expect(control(session)?.items.map(item => item.text)).toEqual(["One", "Two"])

		const plain = await open({ body: p("x ") })

		select(plain.session, 1)
		expect(plain.session.snapshot().enabled["control.items"]).toBe(false)
	})

	it("gives a new date control the caret language's short date and that language", async () => {
		const german = await open({
			body: '<w:p><w:r><w:rPr><w:lang w:val="de-DE"/></w:rPr><w:t xml:space="preserve">Datum </w:t></w:r></w:p>'
		})

		select(german.session, find(german.session, "Datum") + 3)
		expect(run({ type: "control.insert", kind: "date" }, german.session)).toBe(true)

		const xml = part(await save(german), "word/document.xml")

		expect(xml).toContain('<w:dateFormat w:val="dd.MM.yyyy"/><w:lid w:val="de-DE"/>')
		expect(shortDatePicture("en-GB")).toBe("dd/MM/yyyy")
		expect(shortDatePicture("ja-JP")).toBe("yyyy/MM/dd")
		expect(shortDatePicture("en-US")).toBe("M/d/yyyy")
		// Latin digits and picture letters only, whatever the language writes (no bidi marks).
		for (const language of ["fa-IR", "ar-EG", "th-TH", "bn-BD"]) {
			expect(shortDatePicture(language), language).toMatch(/^[dMy./\- ]+$/)
		}
	})
})
