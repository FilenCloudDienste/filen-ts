import type { Node } from "prosemirror-model"
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import {
	DOCX_COMMAND_FEATURES,
	DOCX_EDITOR_COMMANDS,
	DOCX_PARAGRAPH_STYLES,
	DOCX_PARAGRAPH_STYLE_MENU,
	parseDocxEditorCommand,
	DocxEditorSession,
	shortcutFor,
	type DocxEditorCommand
} from "@filen/office/core/docx/edit"
import { DOCX_KEY_BINDINGS, commandForKey, hostCommandForKey, matchesShortcut, type KeyLike } from "../core/docx/paged/keys"
import { NUMBERING_PART, RICH, STYLES_PART, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

const STYLES = STYLES_PART(
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Fancy"><w:name w:val="Fancy Style"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Something Else"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Bulleted"><w:name w:val="Bulleted"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
)

const NUMBERING = NUMBERING_PART(
	'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>' +
		'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
)

const PARTS = {
	parts: [STYLES, NUMBERING],
	relationships: [
		{ id: "rIdS", type: "styles", target: "styles.xml" },
		{ id: "rIdN", type: "numbering", target: "numbering.xml" }
	]
}

function bullet(text: string): string {
	return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function select(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function selectAll(session: DocxEditorSession): void {
	session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
}

// [text, mark names with their main attribute] of each text node of a paragraph.
function runs(paragraph: Node): [string, string[]][] {
	const out: [string, string[]][] = []

	paragraph.forEach(child => {
		if (child.isText) {
			out.push([
				child.text ?? "",
				child.marks
					.filter(mark => mark.type.name !== "run")
					.map(mark => {
						const value: unknown = mark.attrs["value"] ?? mark.attrs["style"]

						return value === undefined ? mark.type.name : `${mark.type.name}=${String(value)}`
					})
			])
		}
	})

	return out
}

describe("docx editor commands", () => {
	it("describes every command once and parses bridge input", () => {
		const types = DOCX_EDITOR_COMMANDS.map(command => command.type)

		expect(new Set(types).size).toBe(types.length)
		expect(DOCX_PARAGRAPH_STYLE_MENU.map(entry => entry.style)).toEqual([...DOCX_PARAGRAPH_STYLES])
		expect(DOCX_PARAGRAPH_STYLE_MENU.find(entry => entry.style === "heading2")?.shortcut).toBe("mod+alt+2")

		// Feature commands with arguments: docxEditRegistry.test.ts.
		for (const type of DOCX_COMMAND_FEATURES.base.map(command => command.type)) {
			const command = type === "style.set" ? { type, style: "heading1" } : { type }

			expect(parseDocxEditorCommand(JSON.parse(JSON.stringify(command)))).toEqual(command)
		}

		expect(parseDocxEditorCommand({ type: "style.set", style: "heading10" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "style.set" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "format.explode" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "__proto__" })).toBeUndefined()
		expect(parseDocxEditorCommand("format.bold")).toBeUndefined()
		expect(parseDocxEditorCommand(null)).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "format.bold", extra: "ignored" })).toEqual({ type: "format.bold" })
	})

	it("toggles bold with direct formatting only where the style does not give it", async () => {
		const session = await sessionOf({ body: p("plain words") + p("heading text", '<w:pStyle w:val="berschrift1"/>'), ...PARTS })

		select(session, 1, 6)
		expect(session.snapshot().formats.bold).toBe("off")
		expect(session.execute({ type: "format.bold" })).toBe(true)
		expect(runs(session.state.doc.child(0))).toEqual([
			["plain", ["bold=true"]],
			[" words", []]
		])
		expect(session.snapshot().formats.bold).toBe("on")
		expect(session.execute({ type: "format.bold" })).toBe(true)
		expect(runs(session.state.doc.child(0))).toEqual([["plain words", []]])

		// The heading style is bold: switching it off is a direct w:b w:val="0".
		const heading = session.state.doc.child(0).nodeSize

		select(session, heading + 1, heading + 8)
		expect(session.snapshot().formats.bold).toBe("on")
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(1))[0]).toEqual(["heading", ["bold=false"]])
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(1))).toEqual([["heading text", []]])

		// Mixed selections turn on.
		select(session, 1, 6)
		session.execute({ type: "format.bold" })
		select(session, 1, 9)
		expect(session.snapshot().formats.bold).toBe("mixed")
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(0))).toEqual([
			["plain wo", ["bold=true"]],
			["rds", []]
		])
	})

	it("toggles italic, underline and strike, and stored marks at a cursor", async () => {
		const session = await sessionOf({ body: p("some text"), ...PARTS })

		select(session, 1, 5)
		session.execute({ type: "format.italic" })
		session.execute({ type: "format.underline" })
		session.execute({ type: "format.strike" })
		expect(runs(session.state.doc.child(0))[0]).toEqual(["some", ["italic=true", "underline=single", "strike=true"]])
		expect(session.snapshot().formats).toEqual({ bold: "off", italic: "on", underline: "on", strike: "on" })

		select(session, 10)
		session.execute({ type: "format.bold" })
		expect(session.snapshot().formats.bold).toBe("on")
		session.dispatch(session.state.tr.insertText("!"))
		expect(runs(session.state.doc.child(0)).at(-1)).toEqual(["!", ["bold=true"]])
	})

	it("clears direct formatting but keeps the run's source", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:rPr><w:rStyle w:val="Strong"/><w:b/><w:i/><w:color w:val="FF0000"/><w:kern w:val="28"/></w:rPr><w:t>styled</w:t></w:r></w:p>',
			...PARTS
		})

		select(session, 1, 7)
		expect(session.execute({ type: "format.clear" })).toBe(true)
		expect(runs(session.state.doc.child(0))).toEqual([["styled", ["plain"]]])
	})

	it("applies headings by their built-in names and adds missing styles", async () => {
		const session = await sessionOf({ body: p("title") + p("body"), ...PARTS })

		select(session, 2)
		session.execute({ type: "style.set", style: "heading1" })
		expect(session.state.doc.child(0).attrs["styleId"]).toBe("berschrift1")
		expect(session.snapshot().paragraph.style).toBe("heading1")

		// Heading 2 is not defined (the id Heading2 is taken by another style).
		session.execute({ type: "style.set", style: "heading2" })
		expect(session.state.doc.child(0).attrs["styleId"]).toBe("Heading21")
		expect([...session.missingStyles]).toEqual([["Heading21", "heading 2"]])
		expect(session.snapshot().paragraph.style).toBe("heading2")

		session.execute({ type: "style.set", style: "normal" })
		expect(session.state.doc.child(0).attrs["styleId"]).toBeNull()
		expect(session.snapshot().paragraph.style).toBe("normal")

		session.dispatch(session.state.tr.setNodeAttribute(0, "styleId", "Fancy"))
		expect(session.snapshot().paragraph).toMatchObject({ style: "custom", styleName: "Fancy Style", align: "center" })

		selectAll(session)
		expect(session.snapshot().paragraph.style).toBe("mixed")
	})

	it("aligns paragraphs, leaving out what the style already does", async () => {
		const session = await sessionOf({ body: p("one") + p("two", '<w:pStyle w:val="Fancy"/>'), ...PARTS })

		selectAll(session)
		session.execute({ type: "align.justify" })
		expect(session.state.doc.child(0).attrs["align"]).toBe("both")
		expect(session.snapshot().paragraph.align).toBe("justify")
		session.execute({ type: "align.center" })
		expect(session.state.doc.child(0).attrs["align"]).toBe("center")
		expect(session.state.doc.child(1).attrs["align"]).toBeNull()
		session.execute({ type: "align.start" })
		expect(session.state.doc.child(0).attrs["align"]).toBeNull()
		expect(session.state.doc.child(1).attrs["align"]).toBe("left")
		session.execute({ type: "align.end" })
		expect(session.state.doc.child(1).attrs["align"]).toBe("right")
	})

	it("starts, continues and ends lists", async () => {
		const session = await sessionOf({
			body: bullet("first") + p("second") + p("third") + p("fourth", '<w:pStyle w:val="Bulleted"/>'),
			...PARTS
		})
		const doc = session.state.doc
		const second = doc.child(0).nodeSize + 2

		// A paragraph after a bullet joins its list.
		select(session, second)
		expect(session.snapshot().paragraph.list).toBe("none")
		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(1).attrs).toMatchObject({ numId: 1, ilvl: 0 })
		expect(session.snapshot().paragraph).toMatchObject({ list: "bullet", level: 0 })

		// A numbered list has none to continue: it is new.
		const third = second + doc.child(1).nodeSize

		select(session, third)
		session.execute({ type: "list.numbered" })
		expect(session.state.doc.child(2).attrs).toMatchObject({ numId: -1, ilvl: 0 })
		expect([...session.newLists]).toEqual([[-1, { kind: "numbered", basedOn: 2 }]])
		expect(session.snapshot().paragraph.list).toBe("numbered")

		// Indent and outdent move between levels.
		select(session, second)
		session.execute({ type: "list.indent" })
		expect(session.state.doc.child(1).attrs["ilvl"]).toBe(1)
		expect(session.snapshot().enabled["list.outdent"]).toBe(true)
		session.execute({ type: "list.outdent" })
		expect(session.state.doc.child(1).attrs["ilvl"]).toBe(0)

		// Toggling a bullet list off removes the direct numbering; a style's numbering is switched off.
		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(1).attrs).toMatchObject({ numId: null, ilvl: null })

		const fourth = session.state.doc.content.size - 2

		select(session, fourth)
		expect(session.snapshot().paragraph.list).toBe("bullet")
		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(3).attrs).toMatchObject({ numId: 0, ilvl: null })
		expect(session.snapshot().paragraph.list).toBe("none")
	})

	it("indents paragraphs outside lists in half-inch steps", async () => {
		const session = await sessionOf({ body: p("text", '<w:ind w:left="300" w:leftChars="100"/>'), ...PARTS })

		select(session, 2)
		session.execute({ type: "list.indent" })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 720 })
		session.execute({ type: "list.indent" })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 1440 })
		session.execute({ type: "list.outdent" })
		session.execute({ type: "list.outdent" })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 0 })
		expect(session.snapshot().enabled["list.outdent"]).toBe(false)
	})

	it("undoes and redoes commands, and tracks the saved state", async () => {
		const session = await sessionOf({ body: p("words"), ...PARTS })
		const opened = session.state.doc
		const snapshots: number[] = []
		const stop = session.subscribe(snapshot => snapshots.push(snapshot.version))

		expect(session.snapshot()).toMatchObject({ dirty: false, canUndo: false, canRedo: false })
		select(session, 1, 3)
		session.execute({ type: "format.bold" })
		expect(session.snapshot()).toMatchObject({ dirty: true, canUndo: true })
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(opened)).toBe(true)
		expect(session.snapshot()).toMatchObject({ dirty: false, canRedo: true })
		expect(session.execute({ type: "history.redo" })).toBe(true)
		expect(session.snapshot().dirty).toBe(true)
		session.markSaved()
		expect(session.snapshot().dirty).toBe(false)
		expect(session.execute({ type: "history.redo" })).toBe(false)
		// Listeners hear once per burst of changes.
		await Promise.resolve()
		stop()
		expect(snapshots).toEqual([session.snapshot().version])
	})

	it("refuses every write command in read-only mode", async () => {
		const session = await sessionOf({ body: p("words"), ...PARTS }, { readOnly: true })
		const doc = session.state.doc

		select(session, 1, 3)

		const snapshot = session.snapshot()

		expect(snapshot).toMatchObject({ readOnly: true, readOnlyReasons: ["host"] })
		expect(Object.values(snapshot.enabled).every(enabled => !enabled)).toBe(true)

		const commands: DocxEditorCommand[] = DOCX_EDITOR_COMMANDS.map(command =>
			command.type === "style.set" ? { type: command.type, style: "heading1" } : ({ type: command.type } as DocxEditorCommand)
		)

		for (const command of commands) expect(session.execute(command)).toBe(false)

		expect(session.state.doc).toBe(doc)
		// The selection still moves (copy and find work).
		expect(session.state.selection.from).toBe(1)
	})

	it("opens protected documents read-only with the gate's reason", async () => {
		const session = await sessionOf({
			body: p("words"),
			settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>'
		})

		expect(session.snapshot()).toMatchObject({ readOnly: true, readOnlyReasons: ["protected"] })
		expect(session.execute({ type: "format.bold" })).toBe(false)
	})

	it("disables paragraph commands on a locked block and reports why it is locked", async () => {
		const session = await sessionOf(RICH)
		let pos = 0

		for (let k = 0; k < 3; k++) pos += session.state.doc.child(k).nodeSize

		session.dispatch(session.state.tr.setSelection(NodeSelection.create(session.state.doc, pos)))

		const snapshot = session.snapshot()

		expect(snapshot.selection).toMatchObject({ locked: "fieldSpansBlocks", paragraphs: 0 })
		expect(snapshot.enabled["format.bold"]).toBe(false)
		expect(snapshot.enabled["style.set"]).toBe(false)
		expect(session.execute({ type: "align.center" })).toBe(false)
	})

	it("formats run content and fields (their runs take it, §17.16.4.3): markers stay as they are", async () => {
		const session = await sessionOf(RICH)

		selectAll(session)
		expect(session.execute({ type: "format.italic" })).toBe(true)

		session.state.doc.child(0).forEach(child => {
			const italic = child.marks.some(mark => mark.type.name === "italic")

			expect(italic, child.type.name).toBe(child.type.name !== "marker" && child.type.name !== "math")
		})
	})

	it("undoes formatting commands to exactly what each run had", async () => {
		const session = await sessionOf({
			body:
				"<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>aa</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bb</w:t></w:r>" +
				'<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>cc</w:t></w:r><w:r><w:t>dd</w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>ee</w:t></w:r></w:p>',
			...PARTS
		})
		const before = session.state.doc

		for (const command of ["format.clear", "format.bold", "format.italic"] as const) {
			selectAll(session)
			expect(session.execute({ type: command })).toBe(true)
			expect(session.execute({ type: "history.undo" })).toBe(true)
			expect(session.state.doc.eq(before), command).toBe(true)
		}
	})

	it("clears direct formatting but the language, like Ctrl+Space", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:rPr><w:b/><w:vanish/><w:position w:val="6"/><w:w w:val="200"/><w:lang w:val="de-DE"/></w:rPr><w:t>hidden</w:t></w:r></w:p>',
			...PARTS
		})

		select(session, 1, 7)
		session.execute({ type: "format.clear" })
		expect(runs(session.state.doc.child(0))).toEqual([["hidden", ["plain", "lang"]]])
		expect(session.snapshot().formats.bold).toBe("off")
		// Text typed there stays plain.
		select(session, 7)
		session.dispatch(session.state.tr.insertText("!"))
		expect(runs(session.state.doc.child(0))).toEqual([["hidden!", ["plain", "lang"]]])
	})

	it("reads and toggles complex-script bold on right-to-left runs", async () => {
		const session = await sessionOf({
			body: "<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:bCs/><w:rtl/></w:rPr><w:t>نص</w:t></w:r></w:p>" + p("latin"),
			...PARTS
		})

		select(session, 1, 3)
		expect(session.snapshot().formats.bold).toBe("on")
		session.execute({ type: "format.bold" })
		expect(session.snapshot().formats.bold).toBe("off")
		expect(runs(session.state.doc.child(0))).toEqual([["نص", []]])
	})

	it("continues the document's bullet list and restarts numbering on its numbered definition", async () => {
		const session = await sessionOf({ body: bullet("far away") + p("a") + p("b") + p("c"), ...PARTS })
		const doc = session.state.doc
		const third = doc.child(0).nodeSize + doc.child(1).nodeSize + 2

		select(session, third)
		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(2).attrs["numId"]).toBe(1)
		expect([...session.newLists]).toEqual([])

		select(session, third + doc.child(2).nodeSize)
		session.execute({ type: "list.numbered" })
		expect([...session.newLists]).toEqual([[-1, { kind: "numbered", basedOn: 2 }]])
		// Lists and styles nothing uses any more are not reported to the writer.
		session.execute({ type: "history.undo" })
		expect([...session.newLists]).toEqual([])
	})

	it("never bases a new numbered list on heading-linked, legal or multi-placeholder numbering", async () => {
		const numbering = NUMBERING_PART(
			'<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="upperRoman"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="Article %1"/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="2"><w:styleLink w:val="Outline"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="Step %1"/></w:lvl></w:abstractNum>' +
				'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
				'<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>' +
				'<w:num w:numId="5"><w:abstractNumId w:val="4"/></w:num>'
		)
		const session = await sessionOf({ body: p("a"), ...PARTS, parts: [STYLES, numbering] })

		select(session, 1)
		session.execute({ type: "list.numbered" })
		expect([...session.newLists]).toEqual([[-1, { kind: "numbered", basedOn: 5 }]])
	})

	it("starts a built-in numbered list when only heading-linked numbering exists", async () => {
		const numbering = NUMBERING_PART(
			'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum>' +
				'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
		)
		const session = await sessionOf({ body: p("a"), ...PARTS, parts: [STYLES, numbering] })

		select(session, 1)
		session.execute({ type: "list.numbered" })
		expect([...session.newLists]).toEqual([[-1, { kind: "numbered", basedOn: null }]])
	})

	it("counts an extended selection the same as a fresh one", async () => {
		const session = await sessionOf(RICH)
		const size = session.state.doc.content.size
		let seed = 7
		const next = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff

			return seed % n
		}

		for (let round = 0; round < 60; round++) {
			const state = session.state
			const anchor = state.selection.anchor
			const head = Math.max(0, Math.min(size, state.selection.head + next(41) - 20))
			const selection = TextSelection.between(state.doc.resolve(round % 7 === 0 ? next(size) : anchor), state.doc.resolve(head))

			session.dispatch(state.tr.setSelection(selection))

			const other = new DocxEditorSession(session.context)

			other.dispatch(
				other.state.tr.setSelection(
					TextSelection.between(other.state.doc.resolve(selection.anchor), other.state.doc.resolve(selection.head))
				)
			)

			const a = session.snapshot()
			const b = other.snapshot()

			expect({ formats: a.formats, paragraph: a.paragraph, paragraphs: a.selection.paragraphs }, `round ${round}`).toEqual({
				formats: b.formats,
				paragraph: b.paragraph,
				paragraphs: b.selection.paragraphs
			})
		}
	})
})

// A key event for `shortcut` on a US layout: the character the key gives (shifted where Shift is held) and its
// physical code.
const SHIFTED: Readonly<Record<string, string>> = {
	"1": "!",
	"2": "@",
	"3": "#",
	"4": "$",
	"5": "%",
	"6": "^",
	"7": "&",
	"8": "*",
	"9": "(",
	"0": ")",
	"=": "+",
	"-": "_",
	".": ">",
	",": "<",
	"[": "{",
	"]": "}"
}

const CODES: Readonly<Record<string, string>> = {
	"=": "Equal",
	"-": "Minus",
	".": "Period",
	",": "Comma",
	"[": "BracketLeft",
	"]": "BracketRight",
	space: "Space",
	enter: "Enter"
}

function eventFor(shortcut: string, apple: boolean): KeyLike {
	const parts = shortcut.split("+")
	const last = parts[parts.length - 1] ?? ""
	const name = last.toLowerCase()
	const shift = parts.includes("shift")
	const mod = parts.includes("mod")
	const ctrl = parts.includes("ctrl")
	const code = /^[a-z]$/.test(name) ? `Key${name.toUpperCase()}` : /^[0-9]$/.test(name) ? `Digit${name}` : (CODES[name] ?? last)
	const key =
		name === "space"
			? " "
			: name === "enter"
				? "Enter"
				: /^f[0-9]+$/.test(name)
					? last
					: shift
						? (SHIFTED[name] ?? name.toUpperCase())
						: name

	return {
		key,
		code,
		metaKey: apple && mod,
		ctrlKey: apple ? ctrl : mod || ctrl,
		shiftKey: shift,
		altKey: parts.includes("alt")
	}
}

describe("docx shortcut matching", () => {
	const b = (mods: Partial<KeyLike> = {}): KeyLike => ({
		key: "b",
		code: "KeyB",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods
	})

	it("reads mod as Cmd on Apple platforms and Ctrl elsewhere, the other modifier held refusing it", () => {
		expect(matchesShortcut(b({ metaKey: true }), "mod+b", true)).toBe(true)
		expect(matchesShortcut(b({ ctrlKey: true }), "mod+b", true)).toBe(false)
		expect(matchesShortcut(b({ metaKey: true, ctrlKey: true }), "mod+b", true)).toBe(false)
		expect(matchesShortcut(b({ ctrlKey: true }), "mod+b", false)).toBe(true)
		expect(matchesShortcut(b({ metaKey: true }), "mod+b", false)).toBe(false)
		expect(matchesShortcut(b({ ctrlKey: true, metaKey: true }), "mod+b", false)).toBe(false)
		expect(matchesShortcut(b(), "mod+b", false)).toBe(false)
		// ctrl is Control on every platform.
		expect(matchesShortcut(b({ ctrlKey: true }), "ctrl+b", true)).toBe(true)
		expect(matchesShortcut(b({ metaKey: true }), "ctrl+b", true)).toBe(false)
	})

	it("matches Shift and Alt exactly", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(matchesShortcut(b({ ...mod, shiftKey: true }), "mod+b", apple)).toBe(false)
			expect(matchesShortcut(b({ ...mod, altKey: true }), "mod+b", apple)).toBe(false)
			expect(matchesShortcut(b({ ...mod }), "mod+shift+b", apple)).toBe(false)
			expect(matchesShortcut(b({ ...mod }), "mod+alt+b", apple)).toBe(false)
			expect(matchesShortcut(b({ ...mod, key: "B", shiftKey: true }), "mod+shift+b", apple)).toBe(true)
		}
	})

	it("falls back to the physical key for shifted digits, Option-composed letters and Space", () => {
		expect(matchesShortcut(b({ key: "*", code: "Digit8", ctrlKey: true, shiftKey: true }), "mod+shift+8", false)).toBe(true)
		expect(matchesShortcut(b({ key: "*", code: "Digit8", metaKey: true, shiftKey: true }), "mod+shift+8", true)).toBe(true)
		expect(matchesShortcut(b({ key: "*", code: "Digit7", ctrlKey: true, shiftKey: true }), "mod+shift+8", false)).toBe(false)
		expect(matchesShortcut(b({ key: "å", code: "KeyA", metaKey: true, altKey: true }), "mod+alt+a", true)).toBe(true)
		expect(matchesShortcut(b({ key: "å", code: "KeyB", metaKey: true, altKey: true }), "mod+alt+a", true)).toBe(false)
		expect(matchesShortcut(b({ key: " ", code: "", ctrlKey: true }), "mod+space", false)).toBe(true)
		expect(matchesShortcut(b({ key: " ", code: "Space", ctrlKey: true }), "mod+space", false)).toBe(true)
		expect(matchesShortcut(b({ key: "x", code: "KeyX", ctrlKey: true }), "mod+space", false)).toBe(false)
	})
})

describe("docx command keys", () => {
	it("runs every command's own shortcut, and its other shortcuts, on both platforms", () => {
		for (const apple of [false, true]) {
			for (const command of DOCX_EDITOR_COMMANDS) {
				if (command.type === "style.set") continue

				for (const shortcut of [shortcutFor(command, apple), ...(command.alsoShortcuts ?? [])]) {
					if (shortcut === undefined) continue

					const event = eventFor(shortcut, apple)

					if (command.hostShortcut === true) {
						expect([apple, shortcut, hostCommandForKey(event, apple)]).toEqual([apple, shortcut, command.type])
						expect([apple, shortcut, commandForKey(event, apple)]).toEqual([apple, shortcut, undefined])
					} else {
						expect([apple, shortcut, commandForKey(event, apple, true)]).toEqual([apple, shortcut, { type: command.type }])
					}
				}
			}
		}
	})

	it("sets each style-menu style by its shortcut, never a bare style.set", () => {
		let bound = 0

		for (const apple of [false, true]) {
			for (const entry of DOCX_PARAGRAPH_STYLE_MENU) {
				if (entry.shortcut === undefined) continue

				bound++
				expect([apple, entry.shortcut, commandForKey(eventFor(entry.shortcut, apple), apple)]).toEqual([
					apple,
					entry.shortcut,
					{ type: "style.set", style: entry.style }
				])
			}
		}

		expect(bound).toBeGreaterThan(0)

		for (const apple of [false, true]) {
			for (const command of DOCX_EDITOR_COMMANDS) {
				for (const shortcut of [shortcutFor(command, apple), ...(command.alsoShortcuts ?? [])]) {
					if (shortcut === undefined) continue

					const found = commandForKey(eventFor(shortcut, apple), apple, true)

					expect(found?.type === "style.set" && !("style" in found)).toBe(false)
				}
			}
		}
	})

	it("runs the argument bindings with their arguments, desktop-only ones only in the desktop app", () => {
		for (const apple of [false, true]) {
			for (const binding of DOCX_KEY_BINDINGS) {
				const shortcut = shortcutFor(binding, apple)

				if (shortcut === undefined) continue

				const event = eventFor(shortcut, apple)

				expect(commandForKey(event, apple, true)).toEqual(binding.command)
				expect(commandForKey(event, apple, false)).toEqual(binding.desktop === true ? undefined : binding.command)
			}
		}
	})
})
