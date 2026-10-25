import { describe, expect, expectTypeOf, it } from "vitest"
import { RevisionView } from "@filen/office/core/docx"
import {
	DOCX_EDITOR_COMMANDS,
	DOCX_PARAGRAPH_STYLES,
	NO_REVIEW,
	NO_VALUES,
	type DocxEditorSnapshot,
	type ReplaceAllResult
} from "@filen/office/core/docx/edit"
import {
	COMMAND_LABELS,
	DOCX_COMMAND_CATALOGUE,
	HIGHLIGHT_SWATCHES,
	MARGIN_PRESETS,
	PAPER_SIZES,
	STANDARD_SWATCHES,
	borderDragOffset,
	borderDragWidth,
	commandVariants,
	contextCommands,
	controlLockedKey,
	fromTwips,
	lengthUnit,
	marginsPresetOf,
	pageSetupCommand,
	pageSetupForm,
	painterAction,
	paperOf,
	paragraphCommands,
	paragraphForm,
	drawingItems,
	typeAhead,
	TYPE_AHEAD_MS,
	themeSwatches,
	toTwips,
	turnedMargins,
	commandActive,
	commandFeature,
	editorMarkupView,
	featureEditable,
	rowCommands,
	slotCommands,
	type DocxUncataloguedCommand,
	editorMarks,
	editorViewOnlyReasons,
	firstMatchFrom,
	replaceAllToast,
	lockReasonKey,
	featureLanded,
	markupRelayout,
	objectInteractions,
	shownMarkup,
	sameToolbarSnapshot,
	shortcutKeys,
	stepMatch,
	styleLabel
} from "@/features/preview/components/docxEditor.logic"
import { viewOnlyReasonKey, viewOnlyReasons } from "@/features/preview/components/docxViewer.logic"
import { preview as en } from "@/locales/en/preview"

const VALUES = NO_VALUES
const CONTEXT: DocxEditorSnapshot["context"] = {
	story: { kind: "body", index: 0 },
	table: null,
	drawing: null,
	control: null,
	field: null,
	link: null,
	comment: null,
	equation: null
}
const REVIEW = NO_REVIEW

function snapshot(overrides: Partial<DocxEditorSnapshot> = {}): DocxEditorSnapshot {
	const enabled = Object.fromEntries(DOCX_EDITOR_COMMANDS.map(command => [command.type, true])) as DocxEditorSnapshot["enabled"]

	return {
		version: 1,
		readOnly: false,
		readOnlyReasons: [],
		dirty: false,
		canUndo: false,
		canRedo: false,
		selection: { empty: true, from: 1, to: 1, locked: null, paragraphs: 1 },
		formats: { bold: "on", italic: "mixed", underline: "off", strike: "off" },
		paragraph: { style: "normal", styleName: null, align: "center", list: "bullet", level: 0 },
		values: VALUES,
		context: CONTEXT,
		review: REVIEW,
		enabled,
		...overrides
	}
}

describe("docx editor toolbar logic", () => {
	it("keeps the toolbar's snapshot across keystrokes and changes it when anything it shows changes", () => {
		const shown = snapshot()

		// Typing moves the selection and bumps the version: nothing the toolbar shows.
		expect(
			sameToolbarSnapshot(
				shown,
				snapshot({ version: 2, dirty: true, selection: { empty: true, from: 9, to: 9, locked: null, paragraphs: 1 } })
			)
		).toBe(true)
		expect(sameToolbarSnapshot(shown, snapshot({ formats: { ...shown.formats, bold: "off" } }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ paragraph: { ...shown.paragraph, list: "none" } }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ enabled: { ...shown.enabled, "history.undo": false } }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ canUndo: true }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ values: { ...VALUES, size: 24 } }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ review: { ...REVIEW, tracking: true } }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ readOnly: true, readOnlyReasons: ["host"] }))).toBe(false)
		expect(sameToolbarSnapshot(shown, snapshot({ selection: { empty: false, from: 1, to: 5, locked: "proof", paragraphs: 1 } }))).toBe(
			false
		)
		expect(sameToolbarSnapshot(undefined, shown)).toBe(false)
		expect(sameToolbarSnapshot(undefined, undefined)).toBe(true)
	})

	it("labels every base command and every paragraph style with a real key", () => {
		for (const command of DOCX_EDITOR_COMMANDS) {
			const label = COMMAND_LABELS[command.type]

			if (commandFeature(command.type) === "base") {
				expect(label, command.type).toBeDefined()
			}

			if (label !== undefined) {
				expect(en).toHaveProperty(label)
			}
		}

		for (const style of DOCX_PARAGRAPH_STYLES) {
			expect(en).toHaveProperty(styleLabel(style).key)
		}

		expect(styleLabel("heading3")).toEqual({ key: "previewDocxStyleHeading", level: 3 })
		expect(styleLabel("quote")).toEqual({ key: "previewDocxStyleQuote" })
	})

	it("shows toggles on only when the whole selection has them, and the alignment and list in effect", () => {
		const state = snapshot()

		expect(commandActive(state, "format.bold")).toBe(true)
		expect(commandActive(state, "format.italic")).toBe(false)
		expect(commandActive(state, "align.center")).toBe(true)
		expect(commandActive(state, "align.start")).toBe(false)
		expect(commandActive(state, "list.bullet")).toBe(true)
		expect(commandActive(state, "list.numbered")).toBe(false)
		expect(commandActive(state, "history.undo")).toBe(false)
	})

	it("shows shortcuts with the platform's modifier names", () => {
		expect(shortcutKeys("mod+shift+z", true)).toEqual(["⌘", "⇧", "Z"])
		expect(shortcutKeys("mod+alt+1", false)).toEqual(["Ctrl", "Alt", "1"])
		expect(shortcutKeys("mod+space", false)).toEqual(["Ctrl", "Space"])
	})

	it("explains read-only editing with keys that exist", () => {
		expect(editorViewOnlyReasons(["host", "protected", "linkedTextbox"], true, false)).toEqual(["protected", "linkedTextbox"])
		expect(editorViewOnlyReasons([], false, false)).toEqual(["notWritable"])
		expect(editorViewOnlyReasons([], false, true)).toEqual(["renamed"])

		for (const reason of ["renamed", "notWritable", "linkedTextbox", "textboxFallback", "lockedTextbox", "protected"] as const) {
			expect(en).toHaveProperty(viewOnlyReasonKey(reason))
		}

		for (const reason of ["contentLocked", "proof", "tableStructure", "fieldSpansBlocks"] as const) {
			expect(en).toHaveProperty(lockReasonKey(reason))
		}
	})
})

describe("docx command catalogue", () => {
	it("places every package command in exactly one feature, and lists only package commands", () => {
		expectTypeOf<DocxUncataloguedCommand>().toEqualTypeOf<never>()

		for (const command of DOCX_EDITOR_COMMANDS) {
			expect(commandFeature(command.type), command.type).toBeDefined()
		}

		const ids: string[] = Object.values(DOCX_COMMAND_CATALOGUE).flat()

		expect(new Set(ids).size).toBe(ids.length)
		expect(ids.toSorted()).toEqual(DOCX_EDITOR_COMMANDS.map(command => command.type).toSorted())
	})

	it("shows the row's groups from base commands only, and a slot only its labelled commands", () => {
		expect(rowCommands("history").map(command => command.info.type)).toEqual(["history.undo", "history.redo"])
		expect(rowCommands("style")).toEqual([])
		expect(rowCommands("align").map(command => command.label)).toEqual([
			"previewDocxAlignStart",
			"previewDocxAlignCenter",
			"previewDocxAlignEnd",
			"previewDocxAlignJustify"
		])

		for (const slot of ["home", "insert", "layout", "references", "review", "view", "table", "picture"] as const) {
			for (const command of slotCommands(slot)) {
				expect(commandFeature(command.info.type)).not.toBe("base")
				expect(COMMAND_LABELS[command.info.type]).toBe(command.label)
			}
		}
	})

	it("offers every labelled command of a landed feature on a ribbon tab, but form controls (used in the document)", () => {
		const tabs = ["home", "insert", "layout", "references", "review", "view", "table", "picture"] as const
		const offered = new Set(tabs.flatMap(tab => slotCommands(tab).map(command => command.info.type)))

		for (const feature of Object.keys(DOCX_COMMAND_CATALOGUE) as (keyof typeof DOCX_COMMAND_CATALOGUE)[]) {
			if (feature === "base" || feature === "forms" || !featureLanded(feature)) {
				continue
			}

			expect(
				DOCX_COMMAND_CATALOGUE[feature].some(type => offered.has(type)),
				feature
			).toBe(true)
		}

		// Each command on one tab only.
		const all = tabs.flatMap(tab => slotCommands(tab).map(command => command.info.type))

		expect(new Set(all).size).toBe(all.length)
		expect(slotCommands("layout").map(command => command.info.type)).toEqual(
			expect.arrayContaining(["insert.sectionBreak", "page.setup"])
		)
		expect(slotCommands("references").map(command => command.info.type)).toEqual(
			expect.arrayContaining(["toc.insert", "note.insertFootnote", "field.updateAll"])
		)
	})
})

describe("docx editor find logic", () => {
	const matches = [
		{ from: 5, to: 8 },
		{ from: 20, to: 23 },
		{ from: 40, to: 43 }
	]

	it("starts at the first match from the caret, wrapping to the first", () => {
		expect(firstMatchFrom(matches, 0)).toBe(0)
		expect(firstMatchFrom(matches, 20)).toBe(1)
		expect(firstMatchFrom(matches, 21)).toBe(2)
		expect(firstMatchFrom(matches, 41)).toBe(0)
		expect(firstMatchFrom([], 3)).toBe(-1)
	})

	it("steps through matches, wrapping both ways", () => {
		expect(stepMatch(2, 3, 1)).toBe(0)
		expect(stepMatch(0, 3, -1)).toBe(2)
		expect(stepMatch(-1, 3, 1)).toBe(0)
		expect(stepMatch(-1, 3, -1)).toBe(2)
		expect(stepMatch(0, 0, 1)).toBe(-1)
	})

	it("merges spelling marks and matches in document order, the current match apart", () => {
		const spelling = [
			{ from: 1, to: 3, kind: "spelling" as const },
			{ from: 21, to: 22, kind: "spelling" as const },
			{ from: 50, to: 55, kind: "repeated" as const }
		]
		const marks = editorMarks(spelling, matches, 1)

		expect(marks.map(mark => `${String(mark.from)}:${mark.kind}`)).toEqual([
			"1:spelling",
			"5:find",
			"20:find-active",
			"21:spelling",
			"40:find",
			"50:repeated"
		])
		expect(editorMarks(spelling, [], -1)).toBe(spelling)
		expect(editorMarks([], [], -1)).toEqual([])
	})
})

describe("markup modes while editing", () => {
	it("lays the document out again only when the pages show another view", () => {
		expect(markupRelayout("final", "none")).toBeNull()
		expect(markupRelayout("final", "all")).toBe("markup")
		expect(markupRelayout("markup", "original")).toBe("original")
		expect(markupRelayout("original", "simple")).toBe("final")
	})

	it("shows the mode the editor's layout has, the user's where it fits", () => {
		expect(editorMarkupView(RevisionView.Markup)).toBe("markup")
		expect(editorMarkupView(RevisionView.Final)).toBe("final")
		expect(editorMarkupView(RevisionView.Original)).toBe("original")
		expect(shownMarkup("none", "final")).toBe("none")
		expect(shownMarkup("simple", "final")).toBe("simple")
		// Another view chosen elsewhere (a command): the menu follows the pages.
		expect(shownMarkup("simple", "markup")).toBe("all")
		expect(shownMarkup("all", "original")).toBe("original")
		expect(shownMarkup("original", "final")).toBe("simple")
	})
})

describe("object presses", () => {
	const press = { hit: { kind: "control", story: 0, pos: 1 } } as never

	it("takes presses only for objects of features offered", () => {
		const landed = (["drawings", "forms", "comments", "fields", "notes", "math"] as const).some(featureLanded)

		expect(
			objectInteractions(
				() => undefined,
				() => true
			) === undefined
		).toBe(!landed)
	})

	it("claims a press only while its feature can change the document", () => {
		const state = snapshot()

		expect(featureEditable(state, false, "base")).toBe(true)
		expect(featureEditable(state, true, "base")).toBe(false)
		expect(featureEditable({ ...state, readOnly: true }, false, "base")).toBe(false)
		expect(featureEditable(undefined, false, "base")).toBe(false)
		expect(
			featureEditable(
				snapshot({
					enabled: { ...state.enabled, ...Object.fromEntries(DOCX_COMMAND_CATALOGUE.forms.map(type => [type, false])) }
				}),
				false,
				"forms"
			)
		).toBe(false)

		const pressed: unknown[] = []
		const interactions = objectInteractions(
			found => pressed.push(found),
			() => false
		)

		expect(interactions?.control?.(press) ?? false).toBe(false)
		expect(interactions?.link).toBeUndefined()
		expect(pressed).toEqual([])
	})
})

describe("view-only paths for templates and macro-enabled documents", () => {
	it("keeps a template read-only where every document is: a public link, an archive, another's link, shared", () => {
		const where = { anon: false, archive: false, linked: false, variant: undefined }

		// No reason of its own any more (the package no longer gates templates).
		expect(viewOnlyReasons([], { ...where, variant: "drive" })).toEqual([])
		expect(viewOnlyReasons([], { ...where, anon: true })).toEqual(["publicLink"])
		expect(viewOnlyReasons([], { ...where, archive: true })).toEqual(["archive"])
		expect(viewOnlyReasons([], { ...where, linked: true })).toEqual(["linkedFile"])
		expect(viewOnlyReasons([], { ...where, variant: "sharedIn" })).toEqual(["sharedIn"])
		expect(viewOnlyReasons(["protected"], { ...where, anon: true })).toEqual(["publicLink", "protected"])
	})
})

describe("formatting, tables and page setup logic", () => {
	it("picks up formatting with a click, keeps it on with a double click and turns it off with a click", () => {
		expect(painterAction(1, "off")).toBe("copy")
		expect(painterAction(2, "off")).toBe("sticky")
		expect(painterAction(1, "once")).toBe("cancel")
		expect(painterAction(1, "sticky")).toBe("cancel")
		// A double click's second click while the first turned it off: on until clicked again.
		expect(painterAction(2, "once")).toBe("sticky")
	})

	it("turns a border drag into the column's width, the other way round in a right-to-left table", () => {
		const ltr = { column: 0, widths: [2000, 2000, 2000], rtl: false, minTwips: 100 }
		const rtl = { ...ltr, rtl: true }

		// 10 screen px at 100 % are 150 twips.
		expect(borderDragWidth(ltr, 10, 1)).toBe(2150)
		expect(borderDragWidth(rtl, 10, 1)).toBe(1850)
		expect(borderDragWidth(rtl, -10, 1)).toBe(2150)
		// At 200 % the same screen distance is half the page distance.
		expect(borderDragWidth(ltr, 10, 2)).toBe(2075)
		// Never narrower than the least, nor wider than the pair leaves the next column.
		expect(borderDragWidth(ltr, -1000, 1)).toBe(100)
		expect(borderDragWidth(ltr, 1000, 1)).toBe(3900)
		// The last column has no neighbour to take from.
		expect(borderDragWidth({ ...ltr, column: 2 }, 1000, 1)).toBe(17_000)
		// The guide follows the pointer.
		expect(borderDragOffset(ltr, 2150, 1)).toBe(10)
		expect(borderDragOffset(rtl, 1850, 1)).toBe(10)
	})

	it("offers Word's theme colour variations, lighter for dark colours and darker for light ones", () => {
		const theme: Record<string, string> = {
			background1: "FFFFFF",
			text1: "000000",
			background2: "E7E6E6",
			text2: "44546A",
			accent1: "4472C4",
			accent2: "ED7D31",
			accent3: "A5A5A5",
			accent4: "FFC000",
			accent5: "5B9BD5",
			accent6: "70AD47"
		}
		const rows = themeSwatches(name => theme[name])

		expect(rows).toHaveLength(6)
		expect(rows.every(row => row.length === 10)).toBe(true)
		expect(rows[0]?.map(swatch => swatch.key)).toEqual(Object.keys(theme).map(name => `theme:${name}`))
		// Accent 1, lighter 60 % (Word's B4C6E7) and darker 25 %.
		expect(rows[2]?.[4]).toMatchObject({
			rgb: "B4C6E7",
			key: "theme:accent1/tint:102",
			color: { kind: "theme", theme: "accent1", tint: 102 }
		})
		expect(rows[4]?.[4]?.color).toEqual({ kind: "theme", theme: "accent1", shade: 191 })
		// Black gets lighter steps from 50 %, white darker ones from 5 %.
		expect(rows[1]?.[1]).toMatchObject({
			rgb: "7F7F7F",
			label: { name: "previewOfficeColorText1", tone: { lighter: true, percent: 50 } }
		})
		expect(rows[1]?.[0]).toMatchObject({ rgb: "F2F2F2", label: { tone: { lighter: false, percent: 5 } } })
		expect(themeSwatches(() => undefined)).toEqual([])

		for (const swatch of [...rows.flat(), ...STANDARD_SWATCHES]) {
			expect(en).toHaveProperty(swatch.label.name)
		}

		for (const swatch of HIGHLIGHT_SWATCHES) {
			expect(en).toHaveProperty(swatch.label)
		}
	})

	it("offers inserting a table or a form control on the Insert tab, and the header toggles only on the chip", () => {
		const insert = slotCommands("insert").map(command => command.info.type)

		expect(insert).toContain("table.insert")
		expect(insert).toContain("control.insert")
		expect(insert).toContain("header.edit")
		expect(insert).not.toContain("header.differentFirst")
		expect(insert).not.toContain("page.setup")
		expect(slotCommands("table").map(command => command.info.type)).not.toContain("table.insert")

		const variants = commandVariants("control.insert") ?? []

		expect(variants.map(variant => ("command" in variant ? variant.command : variant.input))).toEqual([
			{ type: "control.insert", kind: "checkbox" },
			"dropDownList",
			{ type: "control.insert", kind: "date" },
			{ type: "control.insert", kind: "plainText" }
		])

		for (const variant of [...variants, ...(commandVariants("insert.sectionBreak") ?? [])]) {
			expect(en).toHaveProperty(variant.label)
		}

		expect(commandVariants("format.bold")).toBeUndefined()
	})

	it("offers the context menu's commands where the selection is, and only those that can run", () => {
		const table = {
			rows: 2,
			columns: 3,
			fromRow: 0,
			toRow: 1,
			fromColumn: 0,
			toColumn: 1,
			mergeable: false,
			splittable: true,
			headerRow: false,
			styleId: null,
			depth: 0,
			widths: [2000, 2000, 2000],
			align: null,
			vAlign: null,
			shading: null,
			styles: [],
			rtl: false
		}
		const inTable = snapshot({ context: { ...CONTEXT, table } })
		const types = contextCommands(inTable, false).map(command => command.info.type)

		expect(types).toContain("table.row.insertBelow")
		expect(contextCommands(inTable, false).find(command => command.info.type === "table.cell.split")?.action).toBe("input")
		expect(types).not.toContain("control.clear")
		// Read-only: nothing that writes.
		expect(contextCommands(inTable, true).map(command => command.info.type)).not.toContain("table.row.insertBelow")
		// Outside a table, no table commands.
		expect(contextCommands(snapshot(), false).some(command => command.info.type.startsWith("table."))).toBe(false)
		// Disabled commands are left out.
		expect(
			contextCommands({ ...inTable, enabled: { ...inTable.enabled, "table.row.insertBelow": false } }, false).map(
				command => command.info.type
			)
		).not.toContain("table.row.insertBelow")
		expect(en).toHaveProperty(controlLockedKey("bound"))
		expect(en).toHaveProperty(controlLockedKey("contentLocked"))
		expect(en).toHaveProperty(controlLockedKey("disabled"))
	})

	it("sends from the Paragraph dialog only what was changed, and nothing invalid", () => {
		const values = {
			...VALUES,
			indent: { start: 720, end: 0, firstLine: 0, hanging: 360 },
			spacing: { before: 0, after: 160 },
			lineSpacing: { rule: "auto" as const, value: 276 }
		}
		const initial = paragraphForm(values, "in")

		expect(initial).toEqual({
			start: "0.5",
			end: "0",
			special: "hanging",
			by: "0.25",
			before: "0",
			after: "8",
			rule: "auto",
			at: "1.15"
		})
		expect(paragraphCommands(initial, initial, "in")).toEqual([])
		expect(paragraphCommands(initial, { ...initial, start: "1" }, "in")).toEqual([{ type: "paragraph.indent", start: 1440 }])
		expect(paragraphCommands(initial, { ...initial, special: "firstLine", by: "0.5" }, "in")).toEqual([
			{ type: "paragraph.indent", firstLine: 720 }
		])
		expect(paragraphCommands(initial, { ...initial, after: "12", rule: "exact", at: "14" }, "in")).toEqual([
			{ type: "paragraph.spacing", after: 240 },
			{ type: "paragraph.lineSpacing", rule: "exact", value: 280 }
		])
		expect(paragraphCommands(initial, { ...initial, before: "lots" }, "in")).toBeNull()
		// Mixed values start empty, and an empty field changes nothing.
		expect(paragraphForm({ ...VALUES, indent: "mixed" }, "cm").start).toBe("")
		expect(fromTwips(1440, "cm")).toBe(2.54)
		expect(toTwips("2,54", "cm")).toBe(1440)
		expect(Number.isNaN(toTwips("", "in"))).toBe(true)
		expect(lengthUnit("en-US")).toBe("in")
		expect(lengthUnit("en-GB")).toBe("cm")
		expect(lengthUnit("de")).toBe("cm")
	})

	it("turns the Page setup dialog's changes into one page.setup, the page's turn taking its margins along", () => {
		const current = {
			size: { width: 12_240, height: 15_840 },
			orientation: "portrait" as const,
			margins: { top: 1440, bottom: 1440, left: 1080, right: 1080, header: 720, footer: 720, gutter: 0 },
			columns: { count: 1, space: 720, separator: false },
			mirrorMargins: false,
			pageNumbers: { start: null, format: "decimal" as const },
			lineNumbers: null
		}
		const form = pageSetupForm(current)

		expect(paperOf(form.width, form.height)).toBe("letter")
		expect(paperOf(11_900, 16_840)).toBe("a4")
		expect(paperOf(1000, 2000)).toBe("custom")
		expect(marginsPresetOf(form.margins, false)).toBe("moderate")
		expect(pageSetupCommand(current, form)).toBeNull()

		// Turned: the size and orientation go; the margins turn on their own.
		const landscape = { ...form, orientation: "landscape" as const, margins: turnedMargins(form.margins, true) }

		expect(pageSetupCommand(current, landscape)).toEqual({
			type: "page.setup",
			size: { width: 12_240, height: 15_840 },
			orientation: "landscape",
			scope: "section"
		})
		expect(
			pageSetupCommand(current, {
				...form,
				margins: { top: 720, bottom: 720, left: 720, right: 720 },
				columns: 2,
				numberStart: 5,
				numberFormat: "lowerRoman",
				lineNumbers: "newPage",
				scope: "document"
			})
		).toEqual({
			type: "page.setup",
			// The whole document takes the paper and layout too, changed or not (Word's Apply to).
			size: { width: 12_240, height: 15_840 },
			orientation: "portrait",
			margins: { top: 720, bottom: 720, left: 720, right: 720 },
			columns: { count: 2 },
			pageNumbers: { start: 5, format: "lowerRoman" },
			lineNumbers: { countBy: 1, start: 1, restart: "newPage" },
			scope: "document"
		})
		// Nothing changed but "Whole document": every section gets this one's setup.
		expect(pageSetupCommand(current, { ...form, scope: "document" })).toEqual({
			type: "page.setup",
			size: { width: 12_240, height: 15_840 },
			orientation: "portrait",
			margins: form.margins,
			columns: { count: 1 },
			lineNumbers: null,
			scope: "document"
		})
		expect(marginsPresetOf({ top: 1440, bottom: 1440, left: 1800, right: 1800 }, false)).toBe("office2003")
		// A turned page shows a preset's margins turned: Moderate's sides are its top and bottom then.
		expect(marginsPresetOf({ top: 1080, bottom: 1080, left: 1440, right: 1440 }, false, true)).toBe("moderate")
		expect(marginsPresetOf({ top: 1080, bottom: 1080, left: 1440, right: 1440 }, false)).toBe("custom")

		// Mirrored: Word's 1.25" inside and 1" outside, and only with mirror margins on.
		const mirrored = { top: 1440, bottom: 1440, left: 1800, right: 1440 }

		expect(marginsPresetOf(mirrored, true)).toBe("mirrored")
		expect(marginsPresetOf(mirrored, false)).toBe("custom")
		expect(marginsPresetOf(form.margins, true)).toBe("custom")
		expect(pageSetupCommand(current, { ...form, margins: mirrored, mirrored: true })).toEqual({
			type: "page.setup",
			margins: mirrored,
			mirrorMargins: true,
			scope: "section"
		})
		// Turned off on its own: the document's switch alone.
		expect(
			pageSetupCommand(
				{ ...current, mirrorMargins: true },
				{ ...pageSetupForm({ ...current, mirrorMargins: true }), mirrored: false }
			)
		).toEqual({
			type: "page.setup",
			mirrorMargins: false,
			scope: "section"
		})

		for (const paper of PAPER_SIZES) {
			expect(en).toHaveProperty(paper.label)
		}

		for (const preset of MARGIN_PRESETS) {
			expect(en).toHaveProperty(preset.label)
		}
	})
})

describe("context menu and row room for pictures and links", () => {
	const drawing = {
		kind: "picture",
		resizable: true,
		rotation: 0
	} as unknown as NonNullable<DocxEditorSnapshot["context"]["drawing"]>

	it("offers a picture's wrap and rotation as submenus, its crop and alt text by asking, and deletes it as it is", () => {
		const actions = Object.fromEntries(
			contextCommands(snapshot({ context: { ...CONTEXT, drawing } }), false).map(command => [command.info.type, command.action])
		)

		expect(actions["drawing.wrap"]).toBe("variants")
		expect(actions["drawing.rotate"]).toBe("variants")
		expect(actions["drawing.crop"]).toBe("input")
		expect(actions["drawing.altText"]).toBe("input")
		expect(actions["drawing.delete"]).toBe("run")
		expect(commandVariants("drawing.wrap")?.length).toBeGreaterThan(0)
	})

	it("offers editing and removing the link at the caret", () => {
		const link = { target: "https://filen.io", anchor: null, text: "Filen" }
		const actions = Object.fromEntries(
			contextCommands(snapshot({ context: { ...CONTEXT, link } }), false).map(command => [command.info.type, command.action])
		)

		expect(actions["link.set"]).toBe("input")
		expect(actions["link.remove"]).toBe("run")
		expect(contextCommands(snapshot(), false).some(command => command.info.type.startsWith("link."))).toBe(false)
		// A new comment asks for its text, a change at the caret is accepted as it is.
		const review = { ...REVIEW, current: "7", revisionCount: 1 }
		const atChange = Object.fromEntries(
			contextCommands(snapshot({ review }), false).map(command => [command.info.type, command.action])
		)

		expect(atChange["comment.add"]).toBe("input")
		expect(atChange["review.accept"]).toBe("run")
		expect(atChange["review.reject"]).toBe("run")
	})

	it("finds a list's type-ahead entry as the ARIA APG does", () => {
		const texts = ["Red", "Green", "Grey", "Grey blue", "rose"]

		// One character: the next entry starting with it, round the end.
		expect(typeAhead(texts, 0, "g")).toBe(1)
		expect(typeAhead(texts, 4, "R")).toBe(0)
		// The same one repeated: on through the entries starting with it.
		expect(typeAhead(texts, 1, "gg")).toBe(2)
		// More characters: from the active entry on, which stays while it matches.
		expect(typeAhead(texts, 1, "gre")).toBe(1)
		expect(typeAhead(texts, 1, "grey")).toBe(2)
		expect(typeAhead(texts, 2, "grey ")).toBe(3)
		expect(typeAhead(texts, 0, "blue")).toBe(-1)
		expect(typeAhead([], 0, "a")).toBe(-1)
		expect(TYPE_AHEAD_MS).toBe(500)
	})

	it("offers the Picture tab's items in Word's order, without cropping in Mobile view", () => {
		expect(drawingItems(slotCommands("picture"), "pages")).toEqual([
			"drawing.wrap",
			"drawing.rotate",
			"drawing.crop",
			"drawing.altText",
			"drawing.delete"
		])
		expect(drawingItems(slotCommands("picture"), "reflow")).not.toContain("drawing.crop")
	})
})

describe("replaceAllToast", () => {
	it("counts what Replace all replaced and says why it replaced none", () => {
		const tr = {} as Extract<ReplaceAllResult, { readonly tr: unknown }>["tr"]

		expect(replaceAllToast({ tr, count: 3 }, true)).toEqual({ key: "previewDocxReplacedCount", count: 3 })
		// Applied, yet nothing changed (protection left the tracked marking nothing to do).
		expect(replaceAllToast({ tr, count: 3 }, false)).toEqual({ key: "previewDocxReplaceAllUnreplaceable" })
		expect(replaceAllToast({ refused: "tooLarge" }, false)).toEqual({ key: "previewDocxReplaceAllTooLarge" })
		expect(replaceAllToast({ refused: "unreplaceable" }, false)).toEqual({ key: "previewDocxReplaceAllUnreplaceable" })
		expect(replaceAllToast(null, false)).toBeUndefined()
	})
})
