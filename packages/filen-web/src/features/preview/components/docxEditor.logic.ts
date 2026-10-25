import { useState } from "react"
import {
	DOCX_EDITOR_COMMANDS,
	MAX_TABLE_COLUMNS,
	MAX_TABLE_ROWS,
	parseDocxEditorCommand,
	type DocxCommandContext,
	type DocxEditorCommand,
	type DocxEditorCommandGroup,
	type DocxEditorCommandInfo,
	type DocxEditorCommandType,
	type DocxControlContext,
	type DocxEditorSnapshot,
	type DocxStoryContext,
	type DocxHighlightColor,
	type DocxLineNumberRestart,
	type DocxLineSpacingRule,
	type DocxOrientation,
	type DocxPageNumberFormat,
	type DocxParagraphStyle,
	type DocxThemeColor,
	type DocxValuesSnapshot,
	type DocxReadOnlyReason,
	type LockReason,
	type ReplaceAllResult,
	type StoryMatch
} from "@filen/office/core/docx/edit"
import { HIGHLIGHT_COLORS, RevisionView, applyThemeShade, applyThemeTint, hexToRgb, rgbToHsl } from "@filen/office/core/docx"
import { DEFAULT_MARKUP_MODE, markupInfo, type DocxMarkupInfo, type DocxMarkupMode } from "@filen/office/dom/docx"
import type { DocxEditorInteractions, DocxEditorMark, DocxObjectPress } from "@filen/office/react/docx/editor"
import type { DocxCurrentPageSetup, DocxTableBorder, ObjectHitKind } from "@filen/office/core/docx/paged"
import type { SpellingMark } from "@filen/office/core/docx/spelling"
import type { DocxViewOnlyReason } from "@/features/preview/components/docxViewer.logic"
import type { PreviewKey } from "@/lib/i18n"
import type { DocxSwatch } from "@/features/office/lib/officeControls"
import { BASE_LABELS } from "@/features/preview/components/docxCommandLabels/base"
import { FORMATTING_LABELS } from "@/features/preview/components/docxCommandLabels/formatting"
import { INSERT_LABELS } from "@/features/preview/components/docxCommandLabels/insert"
import { COMMENTS_LABELS } from "@/features/preview/components/docxCommandLabels/comments"
import { REVIEW_LABELS } from "@/features/preview/components/docxCommandLabels/review"
import { TABLES_LABELS } from "@/features/preview/components/docxCommandLabels/tables"
import { SECTIONS_LABELS } from "@/features/preview/components/docxCommandLabels/sections"
import { NOTES_LABELS } from "@/features/preview/components/docxCommandLabels/notes"
import { FIELDS_LABELS } from "@/features/preview/components/docxCommandLabels/fields"
import { FORMS_LABELS } from "@/features/preview/components/docxCommandLabels/forms"
import { DRAWINGS_LABELS } from "@/features/preview/components/docxCommandLabels/drawings"
import { MATH_LABELS } from "@/features/preview/components/docxCommandLabels/math"
import { VIEW_LABELS } from "@/features/preview/components/docxCommandLabels/view"
import { CONTROL_INSERT_VARIANTS } from "@/features/preview/components/docxCommandLabels/forms"
import { SECTION_BREAK_VARIANTS } from "@/features/preview/components/docxCommandLabels/sections"
import { ROTATE_VARIANTS, WRAP_VARIANTS } from "@/features/preview/components/docxCommandLabels/drawings"

export { AUTOSAVE_IDLE_MS } from "@/features/office/lib/officeAutosave"

// The package's commands by feature: each feature labels its own in docxCommandLabels/<feature>.ts and fills
// its toolbar slot. An id the package lacks fails `satisfies`, a package id missing here the test's type check.
export const DOCX_COMMAND_CATALOGUE = {
	base: [
		"format.bold",
		"format.italic",
		"format.underline",
		"format.strike",
		"format.clear",
		"style.set",
		"align.start",
		"align.center",
		"align.end",
		"align.justify",
		"list.bullet",
		"list.numbered",
		"list.indent",
		"list.outdent",
		"history.undo",
		"history.redo"
	],
	formatting: [
		"format.superscript",
		"format.subscript",
		"format.doubleStrike",
		"format.smallCaps",
		"format.allCaps",
		"format.clearAll",
		"font.family",
		"font.size",
		"font.grow",
		"font.shrink",
		"font.spacing",
		"color.text",
		"color.highlight",
		"paragraph.lineSpacing",
		"paragraph.spacing",
		"paragraph.indent",
		"format.copy",
		"format.paste"
	],
	insert: ["link.set", "link.remove", "insert.pageBreak", "insert.lineBreak", "insert.horizontalLine", "insert.symbol"],
	comments: [
		"comment.add",
		"comment.reply",
		"comment.edit",
		"comment.resolve",
		"comment.reopen",
		"comment.delete",
		"comment.next",
		"comment.prev"
	],
	review: [
		"review.track",
		"review.accept",
		"review.reject",
		"review.acceptAll",
		"review.rejectAll",
		"review.next",
		"review.prev",
		"view.markup"
	],
	tables: [
		"table.insert",
		"table.delete",
		"table.row.insertAbove",
		"table.row.insertBelow",
		"table.row.delete",
		"table.column.insertLeft",
		"table.column.insertRight",
		"table.column.delete",
		"table.cells.merge",
		"table.cell.split",
		"table.row.header",
		"table.style",
		"table.align",
		"table.column.width",
		"table.cell.shading",
		"table.cell.vAlign",
		"table.distributeColumns"
	],
	sections: [
		"insert.sectionBreak",
		"header.edit",
		"footer.edit",
		"header.differentFirst",
		"header.differentOddEven",
		"header.linkToPrevious",
		"header.remove",
		"footer.remove",
		"section.deleteBreak",
		"page.setup"
	],
	notes: ["note.insertFootnote", "note.insertEndnote", "note.goto", "note.delete", "note.convert", "note.convertAll", "note.options"],
	fields: [
		"field.update",
		"field.updateAll",
		"toc.insert",
		"toc.update",
		"insert.pageNumber",
		"insert.pageCount",
		"insert.date",
		"bookmark.add",
		"insert.field",
		"bookmark.delete",
		"bookmark.rename"
	],
	forms: [
		"control.check",
		"control.choose",
		"control.date",
		"control.clear",
		"control.text",
		"control.insert",
		"control.items",
		"control.item.add",
		"control.item.remove"
	],
	drawings: [
		"image.insert",
		"drawing.resize",
		"drawing.position",
		"drawing.wrap",
		"drawing.altText",
		"drawing.rotate",
		"drawing.crop",
		"drawing.delete"
	],
	math: ["equation.insert", "equation.edit"],
	view: ["view.reflow", "view.fieldCodes", "view.fieldCode"]
} as const satisfies Record<string, readonly DocxEditorCommandType[]>

export type DocxCommandFeature = keyof typeof DOCX_COMMAND_CATALOGUE

type CatalogueCommand<F extends DocxCommandFeature> = (typeof DOCX_COMMAND_CATALOGUE)[F][number]

// Package commands the catalogue does not place: must stay never.
export type DocxUncataloguedCommand = Exclude<DocxEditorCommandType, CatalogueCommand<DocxCommandFeature>>

// A feature's labels: a command is offered once it has one.
export type DocxCommandLabels<F extends DocxCommandFeature> = Readonly<Partial<Record<CatalogueCommand<F>, PreviewKey>>>

export const COMMAND_LABELS: Readonly<Partial<Record<DocxEditorCommandType, PreviewKey>>> = {
	...BASE_LABELS,
	...FORMATTING_LABELS,
	...INSERT_LABELS,
	...COMMENTS_LABELS,
	...REVIEW_LABELS,
	...TABLES_LABELS,
	...SECTIONS_LABELS,
	...NOTES_LABELS,
	...FIELDS_LABELS,
	...FORMS_LABELS,
	...DRAWINGS_LABELS,
	...MATH_LABELS,
	...VIEW_LABELS
}

const FEATURES: ReadonlyMap<string, DocxCommandFeature> = new Map(
	(Object.keys(DOCX_COMMAND_CATALOGUE) as DocxCommandFeature[]).flatMap(feature =>
		DOCX_COMMAND_CATALOGUE[feature].map(type => [type, feature] as const)
	)
)

export function commandFeature(type: DocxEditorCommandType): DocxCommandFeature | undefined {
	return FEATURES.get(type)
}

// The ribbon tab that offers a feature's commands: the Home tab's own groups take the base ones (null), the
// formatting slot is Home's Font and Paragraph groups; form controls have no ribbon place (they are used where
// they are, in the document).
export type DocxToolbarSlot = "home" | "insert" | "layout" | "references" | "review" | "view" | "table" | "picture"

const FEATURE_SLOTS: Readonly<Record<DocxCommandFeature, DocxToolbarSlot | null>> = {
	base: null,
	formatting: "home",
	insert: "insert",
	comments: "review",
	review: "review",
	tables: "table",
	sections: "insert",
	notes: "references",
	fields: "insert",
	forms: null,
	drawings: "picture",
	math: "insert",
	view: "view"
}

// Commands offered somewhere else than their feature's tab: inserting a table, a picture or a form control is
// Insert's, section breaks and page setup Layout's, the table of contents and updating fields References'; the
// header and footer toggles are the header chip's, a field's own code the context menu's.
const COMMAND_SLOTS: Readonly<Partial<Record<DocxEditorCommandType, DocxToolbarSlot | null>>> = {
	"table.insert": "insert",
	"image.insert": "insert",
	"control.insert": "insert",
	"insert.sectionBreak": "layout",
	"page.setup": "layout",
	"toc.insert": "references",
	"toc.update": "references",
	"field.updateAll": "references",
	"header.differentFirst": null,
	"header.differentOddEven": null,
	"header.linkToPrevious": null,
	"header.remove": null,
	"footer.remove": null,
	"section.deleteBreak": null,
	"view.fieldCode": null
}

function slotOf(type: DocxEditorCommandType, feature: DocxCommandFeature): DocxToolbarSlot | null {
	return Object.hasOwn(COMMAND_SLOTS, type) ? (COMMAND_SLOTS[type] ?? null) : FEATURE_SLOTS[feature]
}

export interface DocxToolbarCommand {
	readonly info: DocxEditorCommandInfo
	readonly label: PreviewKey
}

function toolbarCommands(keep: (info: DocxEditorCommandInfo, feature: DocxCommandFeature) => boolean): DocxToolbarCommand[] {
	const out: DocxToolbarCommand[] = []

	for (const info of DOCX_EDITOR_COMMANDS) {
		const feature = commandFeature(info.type)
		const label = COMMAND_LABELS[info.type]

		if (feature !== undefined && label !== undefined && keep(info, feature)) {
			out.push({ info, label })
		}
	}

	return out
}

// The row's buttons of a base group (style.set has its own picker).
export function rowCommands(group: DocxEditorCommandGroup): DocxToolbarCommand[] {
	return toolbarCommands((info, feature) => feature === "base" && info.group === group && info.type !== "style.set")
}

// The labelled commands a ribbon tab offers, in catalogue order.
export function slotCommands(slot: DocxToolbarSlot): DocxToolbarCommand[] {
	return toolbarCommands((info, feature) => slotOf(info.type, feature) === slot)
}

// One form of a command a menu offers as its own item (Insert ▸ Form control ▸ Checkbox): the command to run,
// or the input to ask for (requestInput with the command's type and this detail) where it needs more.
export type DocxCommandVariant =
	{ readonly label: PreviewKey; readonly command: DocxEditorCommand } | { readonly label: PreviewKey; readonly input: string }

const VARIANTS: Readonly<Partial<Record<DocxEditorCommandType, readonly DocxCommandVariant[]>>> = {
	"control.insert": CONTROL_INSERT_VARIANTS,
	"insert.sectionBreak": SECTION_BREAK_VARIANTS,
	"drawing.wrap": WRAP_VARIANTS,
	"drawing.rotate": ROTATE_VARIANTS
}

// The forms a menu offers a command in (a submenu), or undefined for a command run as it is.
export function commandVariants(type: DocxEditorCommandType): readonly DocxCommandVariant[] | undefined {
	return VARIANTS[type]
}

// Whether the selection is in the place a contextual command acts on.
export function contextPresent(snapshot: DocxEditorSnapshot, context: DocxCommandContext): boolean {
	const where = snapshot.context

	switch (context) {
		case "table":
			return where.table !== null
		case "drawing":
			return where.drawing !== null
		case "control":
			return where.control !== null
		case "comment":
			return where.comment !== null
		case "revision":
			return snapshot.review.current !== null
		case "header":
			return where.story.header != null
		case "note":
			return where.story.note != null
	}
}

// What a context menu offers, in its order, and where: a tracked change's accept and reject, a new comment, the
// table's rows, columns and cells, the control's content, the link, the field and the note at the selection,
// the picture's items. Each only once labelled and while it can run.
const CONTEXT_MENU: readonly (readonly [DocxEditorCommandType, DocxCommandContext | "field" | "link" | "always"])[] = [
	["review.accept", "revision"],
	["review.reject", "revision"],
	["comment.add", "always"],
	["table.row.insertAbove", "table"],
	["table.row.insertBelow", "table"],
	["table.column.insertLeft", "table"],
	["table.column.insertRight", "table"],
	["table.row.delete", "table"],
	["table.column.delete", "table"],
	["table.delete", "table"],
	["table.cells.merge", "table"],
	["table.cell.split", "table"],
	["table.distributeColumns", "table"],
	["control.clear", "control"],
	["control.item.add", "control"],
	["control.item.remove", "control"],
	["link.set", "link"],
	["link.remove", "link"],
	["field.update", "field"],
	["view.fieldCode", "field"],
	["note.goto", "note"],
	["note.convert", "note"],
	["note.delete", "note"],
	["drawing.wrap", "drawing"],
	["drawing.rotate", "drawing"],
	["drawing.crop", "drawing"],
	["drawing.altText", "drawing"],
	["drawing.delete", "drawing"]
]

// Commands a context menu runs by asking for their input from the editor's own components (requestInput).
const CONTEXT_INPUTS: ReadonlySet<DocxEditorCommandType> = new Set([
	"table.cell.split",
	"comment.add",
	"link.set",
	"drawing.crop",
	"drawing.altText"
])

// How a context menu item runs its command: as it is, by asking for its input, or through its variants (a
// submenu).
export type DocxContextAction = "run" | "input" | "variants"

export interface DocxContextCommand extends DocxToolbarCommand {
	readonly action: DocxContextAction
}

const INFOS: ReadonlyMap<DocxEditorCommandType, DocxEditorCommandInfo> = new Map(DOCX_EDITOR_COMMANDS.map(info => [info.type, info]))

// The context menu's commands where the selection is.
export function contextCommands(snapshot: DocxEditorSnapshot, readOnly: boolean): DocxContextCommand[] {
	const out: DocxContextCommand[] = []

	for (const [type, where] of CONTEXT_MENU) {
		const info = INFOS.get(type)
		const label = COMMAND_LABELS[type]

		if (info === undefined || label === undefined || !snapshot.enabled[type] || (readOnly && info.write)) {
			continue
		}

		// Notes: the command's enablement says whether the selection is at one.
		if (
			where === "field"
				? snapshot.context.field === null
				: where === "link"
					? snapshot.context.link === null
					: where !== "always" && where !== "note" && !contextPresent(snapshot, where)
		) {
			continue
		}

		const action: DocxContextAction | null = CONTEXT_INPUTS.has(type)
			? "input"
			: VARIANTS[type] !== undefined
				? "variants"
				: info.input === undefined && parseDocxEditorCommand({ type }) !== undefined
					? "run"
					: null

		if (action !== null) {
			out.push({ info, label, action })
		}
	}

	return out
}

// Where the document is shown: its pages, or reflowed to the window's width (Mobile view).
export type DocxSurface = "pages" | "reflow"

// A request for a command's input (a comment's text, an equation's LaTeX, a picture) to the component that
// takes it: from a menu, the context menu or a shortcut, to a balloon, popover or dialog elsewhere.
export interface DocxInputRequest {
	readonly type: DocxEditorCommandType
	// Which form of the input, when a command takes it in several (a picture's source).
	readonly detail?: string
	// New for every request, so asking again for the same input is seen.
	readonly nonce: number
}

export type DocxRequestInput = (type: DocxEditorCommandType, detail?: string) => void

// What every component that takes input through the request channel gets.
export interface DocxInputChannelProps {
	// The open request, until its taker is done with it (onInputDone with its nonce).
	inputRequest: DocxInputRequest | null
	requestInput: DocxRequestInput
	onInputDone: (nonce: number) => void
}

// What a toolbar slot component gets (docxInsertMenu, docxReviewMenu, docxTableMenu, docxFormatControls,
// docxDrawingMenu, the reflow menu item): mounted only once it has commands.
export interface DocxToolbarSlotProps extends DocxInputChannelProps {
	commands: readonly DocxToolbarCommand[]
	snapshot: DocxEditorSnapshot | undefined
	readOnly: boolean
	apple: boolean
	execute: (command: DocxEditorCommand) => void
	surface: DocxSurface
}

// The feature whose commands act on each kind of object a press on the pages can hit; links keep the pages'
// own handling.
const OBJECT_FEATURES: Readonly<Record<ObjectHitKind, DocxCommandFeature | null>> = {
	drawing: "drawings",
	control: "forms",
	commentMarker: "comments",
	field: "fields",
	link: null,
	noteRef: "notes",
	equation: "math",
	tableBorder: "tables"
}

// A feature is offered once any of its commands is labelled.
export function featureLanded(feature: DocxCommandFeature): boolean {
	return DOCX_COMMAND_CATALOGUE[feature].some(type => COMMAND_LABELS[type] !== undefined)
}

// Whether a feature can change the document now: writable, and one of its commands enabled.
export function featureEditable(snapshot: DocxEditorSnapshot | undefined, readOnly: boolean, feature: DocxCommandFeature): boolean {
	return !readOnly && snapshot !== undefined && !snapshot.readOnly && DOCX_COMMAND_CATALOGUE[feature].some(type => snapshot.enabled[type])
}

// Presses on objects of the features offered go to `onPress` (no caret is placed) while `editable` says the
// feature can act; others reach the pages as before. Undefined while no feature is offered.
export function objectInteractions(
	onPress: (press: DocxObjectPress) => void,
	editable: (feature: DocxCommandFeature) => boolean
): DocxEditorInteractions | undefined {
	const entries: [ObjectHitKind, (press: DocxObjectPress) => boolean][] = []

	for (const kind of Object.keys(OBJECT_FEATURES) as ObjectHitKind[]) {
		const feature = OBJECT_FEATURES[kind]

		if (feature !== null && featureLanded(feature)) {
			entries.push([
				kind,
				press => {
					if (!editable(feature)) {
						return false
					}

					onPress(press)

					return true
				}
			])
		}
	}

	return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

export type StyleLabel =
	| { key: "previewDocxStyleHeading"; level: number }
	| { key: "previewDocxStyleNormal" | "previewDocxStyleTitle" | "previewDocxStyleSubtitle" | "previewDocxStyleQuote" }

// The label of a paragraph style in the picker, with the heading level where it has one.
export function styleLabel(style: DocxParagraphStyle): StyleLabel {
	const heading = /^heading(\d)$/.exec(style)?.[1]

	if (heading !== undefined) {
		return { key: "previewDocxStyleHeading", level: Number(heading) }
	}

	switch (style) {
		case "normal":
			return { key: "previewDocxStyleNormal" }
		case "title":
			return { key: "previewDocxStyleTitle" }
		case "subtitle":
			return { key: "previewDocxStyleSubtitle" }
		default:
			return { key: "previewDocxStyleQuote" }
	}
}

// Whether a command is shown as switched on for the selection (a toggle or a radio among alignments/lists).
export function commandActive(snapshot: DocxEditorSnapshot, type: DocxEditorCommandType): boolean {
	switch (type) {
		case "format.bold":
			return snapshot.formats.bold === "on"
		case "format.italic":
			return snapshot.formats.italic === "on"
		case "format.underline":
			return snapshot.formats.underline === "on"
		case "format.strike":
			return snapshot.formats.strike === "on"
		case "align.start":
			return snapshot.paragraph.align === "start"
		case "align.center":
			return snapshot.paragraph.align === "center"
		case "align.end":
			return snapshot.paragraph.align === "end"
		case "align.justify":
			return snapshot.paragraph.align === "justify"
		case "list.bullet":
			return snapshot.paragraph.list === "bullet"
		case "list.numbered":
			return snapshot.paragraph.list === "numbered"
		default:
			return false
	}
}

// The command's platform-neutral shortcut ("mod+shift+z") as keys to show; Cmd on Apple platforms.
export function shortcutKeys(combo: string, apple: boolean): string[] {
	return combo.split("+").map(key => {
		switch (key) {
			case "mod":
				return apple ? "⌘" : "Ctrl"
			case "shift":
				return apple ? "⇧" : "Shift"
			case "alt":
				return apple ? "⌥" : "Alt"
			case "space":
				return "Space"
			default:
				return key.length === 1 ? key.toUpperCase() : key
		}
	})
}

// Why the editor shows the document view-only: the file's own gate reasons (the viewer's), a text box being
// edited, or a file the overlay can no longer save to.
export function editorViewOnlyReasons(reasons: readonly DocxReadOnlyReason[], writable: boolean, renamed: boolean): DocxViewOnlyReason[] {
	const out: DocxViewOnlyReason[] = []

	if (renamed) {
		out.push("renamed")
	} else if (!writable) {
		out.push("notWritable")
	}

	for (const reason of reasons) {
		if (reason !== "host" && !out.includes(reason)) {
			out.push(reason)
		}
	}

	return out
}

export function lockReasonKey(reason: LockReason): PreviewKey {
	switch (reason) {
		case "contentLocked":
			return "previewDocxLockedContent"
		case "proof":
		case "unmodelled":
		case "opaque":
		case "malformed":
			return "previewDocxLockedProof"
		default:
			return "previewDocxLockedStructure"
	}
}

// The match to make current for a new search: the first at or after the caret (as Word continues from it),
// else the first.
export function firstMatchFrom(matches: readonly StoryMatch[], pos: number): number {
	if (matches.length === 0) {
		return -1
	}

	let low = 0
	let high = matches.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((matches[middle]?.from ?? 0) < pos) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return low < matches.length ? low : 0
}

// The next (or previous) match, wrapping around.
export function stepMatch(active: number, count: number, direction: 1 | -1): number {
	if (count === 0) {
		return -1
	}

	if (active < 0) {
		return direction > 0 ? 0 : count - 1
	}

	return (active + direction + count) % count
}

const NO_MARKS: readonly DocxEditorMark[] = []

// Whether two snapshots show the same in the toolbar (formatting, enablement, undo, read-only, the lock at
// the selection, the values, context and review state slots show): the version, the selection's place and the
// dirty flag are not shown there.
export function sameToolbarSnapshot(a: DocxEditorSnapshot | undefined, b: DocxEditorSnapshot | undefined): boolean {
	if (a === b) {
		return true
	}

	if (a === undefined || b === undefined) {
		return false
	}

	return (
		a.readOnly === b.readOnly &&
		a.canUndo === b.canUndo &&
		a.canRedo === b.canRedo &&
		a.selection.locked === b.selection.locked &&
		a.readOnlyReasons.length === b.readOnlyReasons.length &&
		a.readOnlyReasons.every((reason, index) => b.readOnlyReasons[index] === reason) &&
		sameRecord(a.formats, b.formats) &&
		sameRecord(a.paragraph, b.paragraph) &&
		sameRecord(a.enabled, b.enabled) &&
		// The session keeps these objects while their answer is the same.
		a.values === b.values &&
		a.context === b.context &&
		a.review === b.review
	)
}

function sameRecord<T extends object>(a: T, b: T): boolean {
	if (a === b) {
		return true
	}

	const keys = Object.keys(a) as (keyof T)[]

	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

// Spelling marks and find results as one list sorted by `from` (both come sorted), the current match marked
// apart. Find results draw over spelling.
export function editorMarks(spelling: readonly SpellingMark[], matches: readonly StoryMatch[], active: number): readonly DocxEditorMark[] {
	if (matches.length === 0) {
		return spelling.length === 0 ? NO_MARKS : spelling
	}

	const out: DocxEditorMark[] = []
	let s = 0

	for (let k = 0; k < matches.length; k++) {
		const match = matches[k]

		if (match === undefined) {
			continue
		}

		while (s < spelling.length && (spelling[s]?.from ?? 0) <= match.from) {
			const mark = spelling[s]

			if (mark !== undefined) {
				out.push(mark)
			}

			s++
		}

		out.push({ from: match.from, to: match.to, kind: k === active ? "find-active" : "find" })
	}

	for (; s < spelling.length; s++) {
		const mark = spelling[s]

		if (mark !== undefined) {
			out.push(mark)
		}
	}

	return out
}

// How long after a typed character the next one adds to a list's type-ahead (ms), as the ARIA APG has it.
export const TYPE_AHEAD_MS = 500

// The entry type-ahead moves to for `query` (the characters typed within TYPE_AHEAD_MS of each other) from the
// active one, `at`: one character, or the same one repeated, steps to the next entry starting with it; more
// characters match from the active entry on, so it stays while it still matches. -1: none matches.
export function typeAhead(texts: readonly string[], at: number, query: string): number {
	// Each typed key is one character (KeyboardEvent.key of length 1).
	const lower = query.toLocaleLowerCase()
	const first = lower.charAt(0)

	if (first === "" || texts.length === 0) {
		return -1
	}

	const repeated = lower === first.repeat(lower.length)
	const prefix = repeated ? first : lower
	const from = repeated ? at + 1 : at

	for (let offset = 0; offset < texts.length; offset++) {
		const index = (((from + offset) % texts.length) + texts.length) % texts.length

		if (texts[index]?.toLocaleLowerCase().startsWith(prefix) === true) {
			return index
		}
	}

	return -1
}

export type DocxDrawingItem = "drawing.wrap" | "drawing.rotate" | "drawing.crop" | "drawing.altText" | "drawing.delete"

const DRAWING_ITEMS: readonly DocxDrawingItem[] = ["drawing.wrap", "drawing.rotate", "drawing.crop", "drawing.altText", "drawing.delete"]

// The Picture tab's items offered, in Word's order; cropping is the pages' only (its handles are on the page).
export function drawingItems(commands: readonly DocxToolbarCommand[], surface: DocxSurface): DocxDrawingItem[] {
	return DRAWING_ITEMS.filter(
		item => (item !== "drawing.crop" || surface === "pages") && commands.some(command => command.info.type === item)
	)
}

type MarkupView = DocxMarkupInfo["view"]

// How the open document is laid out (the editor's view is what the pages show).
export function editorMarkupView(view: RevisionView): MarkupView {
	return view === RevisionView.Markup ? "markup" : view === RevisionView.Original ? "original" : "final"
}

// The mode the markup menu shows: the user's, while the pages are laid out as it needs; else the default mode of
// the layout the editor shows (a view another surface or command chose).
export function shownMarkup(mode: DocxMarkupMode, view: MarkupView): DocxMarkupMode {
	if (markupInfo(mode).view === view) {
		return mode
	}

	return view === "markup" ? "all" : view === "original" ? "original" : DEFAULT_MARKUP_MODE
}

// The layout switching to `next` needs while the pages show `view`: null when they already do (only what is
// drawn over them changes).
export function markupRelayout(view: MarkupView, next: DocxMarkupMode): MarkupView | null {
	const needed = markupInfo(next).view

	return needed === view ? null : needed
}

// ---- format painter --------------------------------------------------------------------------------------

// The painter as the toolbar shows it: off, on for one paste, or on until turned off.
export type DocxPainterState = "off" | "once" | "sticky"

// What a click on the format painter does (Word's): a click picks up the selection's formatting for the next
// selection, a double click keeps it on for every selection until clicked again or Esc, a click while it is
// on turns it off. `clicks`: the click's count (2 for a double click's second).
export function painterAction(clicks: number, state: DocxPainterState): "copy" | "sticky" | "cancel" {
	if (clicks >= 2) {
		return "sticky"
	}

	return state === "off" ? "copy" : "cancel"
}

// ---- table border drag -----------------------------------------------------------------------------------

// Layout px are 1/96 inch.
export const TWIPS_PER_PX = 15

// The width (twips) of the border's column after dragging the border `deltaPx` screen px to the right at
// `zoom`: in a right-to-left table the column's border is its left one, so a drag to the right narrows it.
// The column keeps at least the narrowest width; with a column after it, that one does too (they share the
// width, as table.column.width does).
export function borderDragWidth(border: DocxTableBorder, deltaPx: number, zoom: number): number {
	const current = border.widths[border.column] ?? 0
	const next = border.widths[border.column + 1]
	const delta = (deltaPx / (zoom > 0 ? zoom : 1)) * TWIPS_PER_PX * (border.rtl ? -1 : 1)
	const most = next === undefined ? Infinity : current + next - border.minTwips

	return Math.round(Math.max(border.minTwips, Math.min(most, current + delta)))
}

// Where the dragged border shows (screen px from where the drag began) for a column `twips` wide.
export function borderDragOffset(border: DocxTableBorder, twips: number, zoom: number): number {
	return (((twips - (border.widths[border.column] ?? 0)) / TWIPS_PER_PX) * zoom) / (border.rtl ? -1 : 1)
}

// ---- colours ---------------------------------------------------------------------------------------------

export { STANDARD_SWATCHES, type DocxSwatch, type DocxSwatchLabel } from "@/features/office/lib/officeControls"

// Word's theme colour columns, in its order.
const THEME_COLUMNS: readonly (readonly [DocxThemeColor, PreviewKey])[] = [
	["background1", "previewOfficeColorBackground1"],
	["text1", "previewOfficeColorText1"],
	["background2", "previewOfficeColorBackground2"],
	["text2", "previewOfficeColorText2"],
	["accent1", "previewOfficeColorAccent1"],
	["accent2", "previewOfficeColorAccent2"],
	["accent3", "previewOfficeColorAccent3"],
	["accent4", "previewOfficeColorAccent4"],
	["accent5", "previewOfficeColorAccent5"],
	["accent6", "previewOfficeColorAccent6"]
]

// The lighter and darker variations Word offers of a theme colour, by its lightness (0–1): pure black and
// white, very dark and very light colours get their own steps, others 80/60/40 % lighter and 25/50 % darker.
function variations(lightness: number): readonly { readonly lighter: boolean; readonly percent: number }[] {
	const lighter = (percent: number) => ({ lighter: true, percent })
	const darker = (percent: number) => ({ lighter: false, percent })

	if (lightness <= 0) return [50, 35, 25, 15, 5].map(lighter)
	if (lightness >= 1) return [5, 15, 25, 35, 50].map(darker)
	if (lightness < 0.2) return [90, 75, 50, 25, 10].map(lighter)
	if (lightness > 0.8) return [10, 25, 50, 75, 90].map(darker)

	return [lighter(80), lighter(60), lighter(40), darker(25), darker(50)]
}

// The theme part of a colour picker as rows (the colours, then each variation), from the document's theme;
// empty without one.
export function themeSwatches(rgbOf: (theme: DocxThemeColor) => string | undefined): readonly (readonly DocxSwatch[])[] {
	const columns: DocxSwatch[][] = []

	for (const [theme, name] of THEME_COLUMNS) {
		const base = rgbOf(theme)?.toUpperCase()

		if (base === undefined || !/^[0-9A-F]{6}$/.test(base)) {
			return []
		}

		const column: DocxSwatch[] = [{ key: `theme:${theme}`, rgb: base, label: { name }, color: { kind: "theme", theme } }]

		for (const tone of variations(rgbToHsl(hexToRgb(base)).l)) {
			const amount = Math.round(255 * (1 - tone.percent / 100))
			const rgb = (tone.lighter ? applyThemeTint(base, amount) : applyThemeShade(base, amount)).toUpperCase()

			column.push({
				key: `theme:${theme}/${tone.lighter ? "tint" : "shade"}:${String(amount)}`,
				rgb,
				label: { name, tone },
				color: tone.lighter ? { kind: "theme", theme, tint: amount } : { kind: "theme", theme, shade: amount }
			})
		}

		columns.push(column)
	}

	return (columns[0] ?? []).map((_, row) =>
		columns.flatMap(column => {
			const swatch = column[row]

			return swatch === undefined ? [] : [swatch]
		})
	)
}

// The highlighter's colours, in Word's order (white is not offered there).
export const HIGHLIGHT_SWATCHES: readonly { readonly name: DocxHighlightColor; readonly rgb: string; readonly label: PreviewKey }[] = (
	[
		["yellow", "previewDocxHighlightYellow"],
		["green", "previewDocxHighlightGreen"],
		["cyan", "previewDocxHighlightCyan"],
		["magenta", "previewDocxHighlightMagenta"],
		["blue", "previewDocxHighlightBlue"],
		["red", "previewDocxHighlightRed"],
		["darkBlue", "previewDocxHighlightDarkBlue"],
		["darkCyan", "previewDocxHighlightDarkCyan"],
		["darkGreen", "previewDocxHighlightDarkGreen"],
		["darkMagenta", "previewDocxHighlightDarkMagenta"],
		["darkRed", "previewDocxHighlightDarkRed"],
		["darkYellow", "previewDocxHighlightDarkYellow"],
		["darkGray", "previewDocxHighlightDarkGray"],
		["lightGray", "previewDocxHighlightLightGray"],
		["black", "previewDocxHighlightBlack"]
	] as const
).map(([name, label]) => ({ name, rgb: HIGHLIGHT_COLORS[name] ?? "000000", label }))

// ---- character and paragraph values ----------------------------------------------------------------------

// A value of the selection as a control shows it: one value, or none ("mixed" and nothing alike).
export function single<T>(value: T | "mixed" | null): T | undefined {
	return value === null || value === "mixed" ? undefined : value
}

// Line spacing Word's menu offers (multiples of a line, 240ths).
export const LINE_SPACINGS: readonly number[] = [240, 276, 360, 480, 600, 720]

// Character spacing steps (twips; negative condenses): Word's Font dialog, by a point and a half.
export const CHARACTER_SPACINGS: readonly { readonly twips: number; readonly label: PreviewKey }[] = [
	{ twips: -60, label: "previewDocxSpacingVeryTight" },
	{ twips: -30, label: "previewDocxSpacingTight" },
	{ twips: 0, label: "previewDocxSpacingNormal" },
	{ twips: 30, label: "previewDocxSpacingLoose" },
	{ twips: 60, label: "previewDocxSpacingVeryLoose" }
]

export type DocxLengthUnit = "in" | "cm"

// The unit lengths are shown in: inches where the locale's region measures in them, else centimetres.
export function lengthUnit(locale: string): DocxLengthUnit {
	const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase()

	return region === "US" || region === "LR" || region === "MM" ? "in" : "cm"
}

// Twips as `unit` (two decimals) and back; NaN for text that is no number.
export function fromTwips(twips: number, unit: DocxLengthUnit): number {
	return Math.round((twips / (unit === "in" ? 1440 : 1440 / 2.54)) * 100) / 100
}

export function toTwips(text: string, unit: DocxLengthUnit): number {
	const value = Number(text.trim().replace(",", "."))

	return text.trim() === "" || !Number.isFinite(value) ? Number.NaN : Math.round(value * (unit === "in" ? 1440 : 1440 / 2.54))
}

// Points (paragraph spacing) as twips and back.
export function pointsOf(twips: number): number {
	return Math.round((twips / 20) * 10) / 10
}

export function pointsToTwips(text: string): number {
	const value = Number(text.trim().replace(",", "."))

	return text.trim() === "" || !Number.isFinite(value) ? Number.NaN : Math.round(value * 20)
}

// The Paragraph dialog's fields as typed (lengths in `unit`, spacing in points, a multiple as lines).
export interface DocxParagraphForm {
	readonly start: string
	readonly end: string
	readonly special: "none" | "firstLine" | "hanging"
	readonly by: string
	readonly before: string
	readonly after: string
	readonly rule: DocxLineSpacingRule
	readonly at: string
}

export function paragraphForm(values: DocxValuesSnapshot, unit: DocxLengthUnit): DocxParagraphForm {
	const indent = single(values.indent)
	const spacing = single(values.spacing)
	const line = single(values.lineSpacing)
	const length = (twips: number | undefined) => (twips === undefined ? "" : String(fromTwips(twips, unit)))
	const special = indent === undefined ? "none" : indent.firstLine > 0 ? "firstLine" : indent.hanging > 0 ? "hanging" : "none"

	return {
		start: length(indent?.start),
		end: length(indent?.end),
		special,
		by: special === "none" ? "" : length(special === "firstLine" ? indent?.firstLine : indent?.hanging),
		before: spacing === undefined ? "" : String(pointsOf(spacing.before)),
		after: spacing === undefined ? "" : String(pointsOf(spacing.after)),
		rule: line?.rule ?? "auto",
		at:
			line === undefined
				? ""
				: line.rule === "auto"
					? String(Math.round((line.value / 240) * 100) / 100)
					: String(pointsOf(line.value))
	}
}

// The commands that set what the Paragraph dialog changed (a field left as it was, or empty, changes nothing);
// null when a changed field holds no valid value.
export function paragraphCommands(initial: DocxParagraphForm, form: DocxParagraphForm, unit: DocxLengthUnit): DocxEditorCommand[] | null {
	const out: DocxEditorCommand[] = []
	const changed = (key: keyof DocxParagraphForm) =>
		form[key] !== initial[key] && (typeof form[key] !== "string" || form[key].trim() !== "")
	const length = (text: string) => toTwips(text, unit)

	if (changed("start") || changed("end") || changed("special") || changed("by")) {
		const start = changed("start") ? length(form.start) : undefined
		const end = changed("end") ? length(form.end) : undefined
		const by = form.special === "none" ? 0 : length(form.by)

		if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(by) || by < 0) return null

		out.push({
			type: "paragraph.indent",
			...(start === undefined ? {} : { start }),
			...(end === undefined ? {} : { end }),
			...(changed("special") || changed("by") ? (form.special === "hanging" ? { hanging: by } : { firstLine: by }) : {})
		})
	}

	if (changed("before") || changed("after")) {
		const before = changed("before") ? pointsToTwips(form.before) : undefined
		const after = changed("after") ? pointsToTwips(form.after) : undefined

		if (Number.isNaN(before) || Number.isNaN(after) || (before ?? 0) < 0 || (after ?? 0) < 0) return null

		out.push({ type: "paragraph.spacing", ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) })
	}

	if ((changed("rule") || changed("at")) && form.at.trim() !== "") {
		const amount = Number(form.at.trim().replace(",", "."))
		const value = form.rule === "auto" ? Math.round(amount * 240) : Math.round(amount * 20)

		if (!Number.isFinite(amount) || value < (form.rule === "auto" ? 1 : 0)) return null

		out.push({ type: "paragraph.lineSpacing", rule: form.rule, value })
	}

	return out
}

// ---- page setup ------------------------------------------------------------------------------------------

// Paper sizes Word's Page Setup offers, portrait (twips).
export const PAPER_SIZES: readonly { readonly id: string; readonly width: number; readonly height: number; readonly label: PreviewKey }[] =
	[
		{ id: "letter", width: 12_240, height: 15_840, label: "previewDocxPaperLetter" },
		{ id: "legal", width: 12_240, height: 20_160, label: "previewDocxPaperLegal" },
		{ id: "executive", width: 10_440, height: 15_120, label: "previewDocxPaperExecutive" },
		{ id: "tabloid", width: 15_840, height: 24_480, label: "previewDocxPaperTabloid" },
		{ id: "a3", width: 16_838, height: 23_811, label: "previewDocxPaperA3" },
		{ id: "a4", width: 11_906, height: 16_838, label: "previewDocxPaperA4" },
		{ id: "a5", width: 8391, height: 11_906, label: "previewDocxPaperA5" }
	]

// Word's margin presets (twips). Mirrored: left and right are the inside and outside margins, swapped on facing
// pages (w:mirrorMargins, ECMA-376 Part 1 §17.15.1.57; Microsoft support "Set mirror margins for facing pages").
export const MARGIN_PRESETS: readonly {
	readonly id: string
	readonly label: PreviewKey
	readonly margins: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number }
	readonly mirrored?: true
}[] = [
	{ id: "normal", label: "previewDocxMarginsNormal", margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
	{ id: "narrow", label: "previewDocxMarginsNarrow", margins: { top: 720, bottom: 720, left: 720, right: 720 } },
	{ id: "moderate", label: "previewDocxMarginsModerate", margins: { top: 1440, bottom: 1440, left: 1080, right: 1080 } },
	{ id: "wide", label: "previewDocxMarginsWide", margins: { top: 1440, bottom: 1440, left: 2880, right: 2880 } },
	// Word's Mirrored: 1" top, bottom and outside, 1.25" inside.
	{
		id: "mirrored",
		label: "previewDocxMarginsMirrored",
		margins: { top: 1440, bottom: 1440, left: 1800, right: 1440 },
		mirrored: true
	},
	// Word's "Office 2003 Default" (1" top and bottom, 1.25" sides).
	{ id: "office2003", label: "previewDocxMarginsOffice2003", margins: { top: 1440, bottom: 1440, left: 1800, right: 1800 } }
]

// Twips a size or margin may differ by and still be the preset (Word rounds them when it writes).
const PRESET_SLACK = 20

export interface DocxMargins {
	readonly top: number
	readonly bottom: number
	readonly left: number
	readonly right: number
}

// The Page setup dialog's choices, twips; the paper portrait (the orientation turns it).
export interface DocxPageSetupForm {
	readonly width: number
	readonly height: number
	readonly orientation: DocxOrientation
	readonly margins: DocxMargins
	// Mirror margins (document-wide): `margins.left` is the inside margin, `margins.right` the outside one.
	readonly mirrored: boolean
	readonly columns: number
	// null: numbering continues from the previous section.
	readonly numberStart: number | null
	readonly numberFormat: DocxPageNumberFormat | null
	readonly lineNumbers: DocxLineNumberRestart | null
	readonly scope: "section" | "document"
}

export function pageSetupForm(current: DocxCurrentPageSetup): DocxPageSetupForm {
	const { width, height } = current.size

	return {
		width: Math.min(width, height),
		height: Math.max(width, height),
		orientation: current.orientation,
		margins: { top: current.margins.top, bottom: current.margins.bottom, left: current.margins.left, right: current.margins.right },
		mirrored: current.mirrorMargins,
		columns: current.columns.count,
		numberStart: current.pageNumbers.start,
		numberFormat: current.pageNumbers.format,
		lineNumbers: current.lineNumbers?.restart ?? null,
		scope: "section"
	}
}

// The preset a portrait paper size is, or "custom".
export function paperOf(width: number, height: number): string {
	return (
		PAPER_SIZES.find(paper => Math.abs(paper.width - width) <= PRESET_SLACK && Math.abs(paper.height - height) <= PRESET_SLACK)?.id ??
		"custom"
	)
}

// The preset margins are (mirrored or not), or "custom".
// `landscape`: the page is turned, its margins with it (a preset applied then is turned too).
export function marginsPresetOf(margins: DocxMargins, mirrored: boolean, landscape = false): string {
	const near = (a: number, b: number) => Math.abs(a - b) <= PRESET_SLACK

	return (
		MARGIN_PRESETS.find(preset => {
			const shown = landscape ? turnedMargins(preset.margins, true) : preset.margins

			return (
				(preset.mirrored === true) === mirrored &&
				near(shown.top, margins.top) &&
				near(shown.bottom, margins.bottom) &&
				near(shown.left, margins.left) &&
				near(shown.right, margins.right)
			)
		})?.id ?? "custom"
	)
}

// The margins after turning the page, as Word's Page Setup turns them (90 degrees).
export function turnedMargins(margins: DocxMargins, landscape: boolean): DocxMargins {
	const { top, right, bottom, left } = margins

	return landscape ? { top: left, bottom: right, left: bottom, right: top } : { top: right, bottom: left, left: top, right: bottom }
}

// page.setup with what the dialog changed (the page turns its margins itself; margins typed after turning it
// go as typed), or null when nothing changed.
export function pageSetupCommand(current: DocxCurrentPageSetup, form: DocxPageSetupForm): DocxEditorCommand | null {
	const before = pageSetupForm(current)
	const turned = form.orientation !== before.orientation
	const expected = turned ? turnedMargins(before.margins, form.orientation === "landscape") : before.margins
	const sized = form.width !== before.width || form.height !== before.height
	const margins =
		form.margins.top !== expected.top ||
		form.margins.bottom !== expected.bottom ||
		form.margins.left !== expected.left ||
		form.margins.right !== expected.right
	const numbers = form.numberStart !== before.numberStart || (form.numberFormat !== before.numberFormat && form.numberFormat !== null)
	const lines = form.lineNumbers !== before.lineNumbers
	const columns = form.columns !== before.columns
	const mirror = form.mirrored !== before.mirrored

	// "Whole document" gives every section the dialog's paper, margins, columns and line numbers, changed or not
	// (Word's Apply to); page numbering stays each section's unless changed.
	const all = form.scope === "document"

	if (!sized && !turned && !margins && !numbers && !lines && !columns && !mirror && !all) {
		return null
	}

	return {
		type: "page.setup",
		...(sized || turned || all ? { size: { width: form.width, height: form.height }, orientation: form.orientation } : {}),
		...(margins || all ? { margins: form.margins } : {}),
		...(columns || all ? { columns: { count: form.columns } } : {}),
		// The document's, whatever the dialog applies to.
		...(mirror ? { mirrorMargins: form.mirrored } : {}),
		...(numbers
			? {
					pageNumbers: {
						...(form.numberStart !== before.numberStart ? { start: form.numberStart } : {}),
						...(form.numberFormat !== null && form.numberFormat !== before.numberFormat ? { format: form.numberFormat } : {})
					}
				}
			: {}),
		...(lines || all
			? {
					lineNumbers:
						form.lineNumbers === null
							? null
							: {
									countBy: current.lineNumbers?.countBy ?? 1,
									start: current.lineNumbers?.start ?? 1,
									restart: form.lineNumbers
								}
				}
			: {}),
		scope: form.scope
	}
}

export type HeaderChipKey = `preview${"Header" | "Footer"}Chip${"" | "First" | "Even" | "Odd"}${"" | "Only"}` extends infer K
	? K extends `preview${infer R}`
		? `previewDocx${R}`
		: never
	: never

// The header chip's name for where it is: the section only once the document has more than one.
export function headerChipKey(header: DocxHeaderContext): HeaderChipKey {
	const footer = header.kind === "footer"
	const sectioned = header.sections > 1

	switch (header.type) {
		case "first":
			return footer
				? sectioned
					? "previewDocxFooterChipFirst"
					: "previewDocxFooterChipFirstOnly"
				: sectioned
					? "previewDocxHeaderChipFirst"
					: "previewDocxHeaderChipFirstOnly"
		case "even":
			return footer
				? sectioned
					? "previewDocxFooterChipEven"
					: "previewDocxFooterChipEvenOnly"
				: sectioned
					? "previewDocxHeaderChipEven"
					: "previewDocxHeaderChipEvenOnly"
		default:
			if (header.differentOddEven) {
				return footer
					? sectioned
						? "previewDocxFooterChipOdd"
						: "previewDocxFooterChipOddOnly"
					: sectioned
						? "previewDocxHeaderChipOdd"
						: "previewDocxHeaderChipOddOnly"
			}

			return footer
				? sectioned
					? "previewDocxFooterChip"
					: "previewDocxFooterChipOnly"
				: sectioned
					? "previewDocxHeaderChip"
					: "previewDocxHeaderChipOnly"
	}
}

// ---- shared by the editor's controls ---------------------------------------------------------------------

export { keepFocus } from "@/features/office/lib/officeControls"

// Word's table limits (ECMA-376 leaves them open; Word stops at 63 columns and 32,767 rows): the package's table
// commands' own.
export const TABLE_LIMITS = { rows: MAX_TABLE_ROWS, columns: MAX_TABLE_COLUMNS } as const

// What a dialog asked for through the input channel holds while it is open: made from the request when it
// arrives (once per request), dropped with it. `matches`: whether a request is this dialog's.
export function useInputForm<T>(
	inputRequest: DocxInputRequest | null,
	matches: (request: DocxInputRequest) => boolean,
	make: (request: DocxInputRequest) => T | null
): { request: DocxInputRequest | null; form: T | null; setForm: (update: (form: T) => T) => void } {
	const request = inputRequest !== null && matches(inputRequest) ? inputRequest : null
	const [held, setHeld] = useState<{ nonce: number; form: T | null } | null>(null)

	if (request !== null && held?.nonce !== request.nonce) {
		setHeld({ nonce: request.nonce, form: make(request) })
	}

	const form = request !== null && held?.nonce === request.nonce ? held.form : null

	return {
		request,
		form,
		setForm: update => {
			setHeld(previous => {
				const form = previous?.form ?? null

				return previous === null || form === null ? previous : { ...previous, form: update(form) }
			})
		}
	}
}

type DocxHeaderContext = NonNullable<DocxStoryContext["header"]>

// ---- form controls ---------------------------------------------------------------------------------------

// The toast Replace All ends with (`changed`: whether its transaction, once applied, changed the document): the
// count, or why it replaced none of the matches find shows (protection may leave a tracked one nothing to do).
export function replaceAllToast(
	result: ReplaceAllResult | null,
	changed: boolean
):
	| { readonly key: "previewDocxReplacedCount"; readonly count: number }
	| { readonly key: "previewDocxReplaceAllUnreplaceable" | "previewDocxReplaceAllTooLarge" }
	| undefined {
	if (result === null) return undefined
	if ("tr" in result)
		return changed ? { key: "previewDocxReplacedCount", count: result.count } : { key: "previewDocxReplaceAllUnreplaceable" }

	return { key: result.refused === "tooLarge" ? "previewDocxReplaceAllTooLarge" : "previewDocxReplaceAllUnreplaceable" }
}

// Why a content control's content cannot be changed, as the control popover and context menu say it.
export function controlLockedKey(locked: NonNullable<DocxControlContext["locked"]>): PreviewKey {
	switch (locked) {
		case "contentLocked":
			return "previewDocxControlLockedContent"
		case "bound":
			return "previewDocxControlLockedBound"
		default:
			return "previewDocxControlLockedDisabled"
	}
}
