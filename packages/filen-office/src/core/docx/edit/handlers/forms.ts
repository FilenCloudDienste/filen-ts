import { Fragment, type Mark, type Node } from "prosemirror-model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import {
	blockControlAround,
	checkboxGlyph,
	controlAround,
	inlineControlAround,
	controlOf,
	controlState,
	EMPTY_FORM_TEXT,
	legacyFieldOf,
	legacyText,
	listItem,
	newControlId,
	placeholderText,
	typableField,
	typeable,
	type ControlAround,
	type ControlInfo,
	type ControlState,
	type LegacyField,
	type LegacyFieldState,
	type MadeControl
} from "../../forms/controls"
import { numericDatePicture } from "../../fields/datePictures"
import { formatControlDate } from "../../forms/dates"
import { watchBoundStories } from "../../forms/sync"
import type { StoryPart } from "../../model/index"
import type { DocxControlKind } from "../commands/forms"
import { caretMarks } from "../formats"
import {
	formCommand,
	formsAfter,
	formsBefore,
	mayHoldControls,
	mayHoldFields,
	placeholderContent,
	placeholderMarks,
	placeholderState,
	textContent,
	withFont,
	writeControl
} from "../invariants/forms"
import type { DocxTransactionTransformer, FeatureHandlers, StoryCommandContext, StoryCommandHandler } from "../registry"
import { docxSchema, NO_SOURCE } from "../schema"

// Form commands: checkboxes, list and date choices, clearing a control, legacy form field values, new controls
// and repeating section items. Each makes one transaction (one undo step) that sets the control's content as
// Word shows it and its state for the writer (forms/controls.ts ControlState).

const nodes = docxSchema.nodes
const marks = docxSchema.marks

// The transformers around tracked changes recording a transaction (registered in handlers/index.ts). A session
// editing a story whose controls share a binding with another story's passes their values on (forms/sync.ts).
export const FORMS_BEFORE: DocxTransactionTransformer = (tr, session) => {
	watchBoundStories(session)

	return formsBefore(tr, session)
}
export const FORMS_AFTER: DocxTransactionTransformer = formsAfter

interface FieldAt {
	readonly node: Node
	readonly pos: number
	readonly field: LegacyField
}

// ---- the selection --------------------------------------------------------------------------------------

function partOf(context: StoryCommandContext): StoryPart {
	return context.session.story.part
}

// The control holding the selection (a selected atom counts as its range).
export function selectedControl(part: StoryPart, state: EditorState): ControlAround | undefined {
	return controlAround(part, state.doc, state.selection.from, state.selection.to)
}

// A legacy form field: the selected field, or the one the caret touches.
export function selectedField(part: StoryPart, state: EditorState): FieldAt | undefined {
	const selection = state.selection
	const $from = selection.$from
	const candidates: [Node | null, number][] =
		selection instanceof NodeSelection
			? [[selection.node, selection.from]]
			: selection.empty
				? [
						[$from.nodeAfter, selection.from],
						[$from.nodeBefore, selection.from - ($from.nodeBefore?.nodeSize ?? 0)]
					]
				: []

	for (const [node, pos] of candidates) {
		if (node === null || node.type !== nodes.field) continue

		const field = legacyFieldOf(part, node)

		if (field !== undefined) return { node, pos, field }
	}

	return undefined
}

// Whether the schema lets a legacy field carry form state (the field node's `state` attribute).
function legacyState(): boolean {
	return Object.hasOwn(nodes.field.spec.attrs ?? {}, "state")
}

function editable(around: ControlAround | undefined, type?: (info: ControlInfo) => boolean): around is ControlAround {
	if (around === undefined) return false

	const blocker = typeable(around.info)

	return blocker !== "contentLocked" && blocker !== "bound" && (type === undefined || type(around.info))
}

// The control holding the selection, looked for only in stories that can hold controls (snapshots ask with
// every change of state).
function controlAt(context: StoryCommandContext): ControlAround | undefined {
	return mayHoldControls(context.session) ? selectedControl(partOf(context), context.state) : undefined
}

function legacyOf(context: StoryCommandContext, type: LegacyField["type"]): FieldAt | undefined {
	if (!mayHoldFields(context.session)) return undefined

	const at = selectedField(partOf(context), context.state)

	return at !== undefined && at.field.enabled && at.field.type === type && legacyState() ? at : undefined
}

// Replaces a control's content with `text` (a checkbox glyph in its `font`) and sets its state.
function setControl(
	context: StoryCommandContext,
	around: ControlAround,
	text: string,
	state: ControlState,
	font: string | null = null
): Transaction {
	const tr = context.state.tr

	writeControl(tr, context.context, around, text, state, font)

	return formCommand(tr.scrollIntoView(), context.session)
}

function showPlaceholder(context: StoryCommandContext, around: ControlAround): Transaction {
	return setControl(
		context,
		around,
		placeholderText(partOf(context), around.holder, around.info),
		placeholderState(around.holder, around.info, true)
	)
}

// Sets a legacy field's state, and a text field's result (a check box or drop-down shows its w:ffData).
function setLegacy(
	context: StoryCommandContext,
	at: FieldAt,
	state: LegacyFieldState,
	result: string = at.node.attrs["result"] as string
): Transaction {
	const previous = (at.node.attrs["state"] as LegacyFieldState | null | undefined) ?? {}
	const tr = context.state.tr

	tr.setNodeAttribute(at.pos, "state", { ...previous, ...state })

	if (result !== at.node.attrs["result"]) tr.setNodeAttribute(at.pos, "result", result)

	return formCommand(tr, context.session)
}

// ---- commands -------------------------------------------------------------------------------------------

function isCheckbox(info: ControlInfo): boolean {
	return info.checkbox !== null
}

function isList(info: ControlInfo): boolean {
	return info.type === "dropDownList" || info.type === "comboBox"
}

function isDate(info: ControlInfo): boolean {
	return info.date !== null
}

function isPlainText(info: ControlInfo): boolean {
	return info.type === "plainText"
}

// Controls clearing empties: text, lists and dates (not a checkbox, picture or a container of controls).
function clearable(info: ControlInfo): boolean {
	return (
		(typeable(info) === undefined || info.type === "dropDownList") &&
		info.type !== "repeatingSection" &&
		info.type !== "repeatingSectionItem" &&
		info.type !== "buildingBlock"
	)
}

const check: StoryCommandHandler<"control.check"> = {
	enabled(context) {
		return editable(controlAt(context), isCheckbox) || legacyOf(context, "FORMCHECKBOX") !== undefined
	},
	run(context) {
		const around = controlAt(context)

		if (editable(around, isCheckbox) && around.info.checkbox !== null) {
			const checked = !around.info.checkbox.checked
			const glyph = checkboxGlyph(around.info.checkbox, checked)

			return setControl(
				context,
				around,
				glyph.text,
				{ ...(controlState(around.holder) ?? {}), checked, placeholder: false },
				glyph.font
			)
		}

		const field = legacyOf(context, "FORMCHECKBOX")

		return field === undefined ? null : setLegacy(context, field, { checked: !field.field.checked })
	}
}

const choose: StoryCommandHandler<"control.choose"> = {
	enabled(context) {
		const around = controlAt(context)

		return (editable(around, isList) && around.info.items.length > 0) || legacyOf(context, "FORMDROPDOWN") !== undefined
	},
	run(context, command) {
		const around = controlAt(context)

		if (editable(around, isList)) {
			const item = listItem(around.info, command.value)

			if (item === undefined) return null
			// Word's "Choose an item." entry (the placeholder's text as a value) shows the placeholder again.
			if (item.text === "" || item.text === placeholderText(partOf(context), around.holder, around.info))
				return showPlaceholder(context, around)

			return setControl(context, around, item.text, { ...(controlState(around.holder) ?? {}), value: item.value, placeholder: false })
		}

		const field = legacyOf(context, "FORMDROPDOWN")
		const index = field?.field.entries.indexOf(command.value) ?? -1

		return field === undefined || index < 0 ? null : setLegacy(context, field, { result: index })
	}
}

// Whether no two entries share a text or a value (Word refuses either): checked here too, as an app may run a
// command it never parsed.
function distinctItems(items: readonly { readonly text: string; readonly value: string }[]): boolean {
	const texts = new Set(items.map(item => item.text))
	const values = new Set(items.map(item => item.value))

	return texts.size === items.length && values.size === items.length
}

// A list's entries replaced (Word's Properties: Add, Remove): the choice stays where its entry does, else the
// placeholder shows again (a drop-down's w:lastValue must name one of its entries).
const items: StoryCommandHandler<"control.items"> = {
	enabled(context) {
		const around = controlAt(context)

		return editable(around, isList)
	},
	run(context, command) {
		const around = controlAt(context)

		if (!editable(around, isList) || !distinctItems(command.items)) return null

		const state = controlState(around.holder) ?? {}
		// An entry the control holds value-only stays so while its text is its value.
		const valueOnly = new Set(around.info.items.filter(item => item.valueOnly === true).map(item => item.value))
		const entries = command.items.map(item =>
			item.text === item.value && valueOnly.has(item.value)
				? { text: item.text, value: item.value, valueOnly: true as const }
				: { text: item.text, value: item.value }
		)
		const next: ControlState =
			state.made !== undefined ? { ...state, made: { ...state.made, items: entries } } : { ...state, items: entries }
		// The entry shown: by w:lastValue, else (a file without one) by the text it shows.
		const shown = context.state.doc.textBetween(around.from, around.to)
		const chosen = around.info.showingPlaceholder
			? undefined
			: around.info.lastValue !== null
				? entries.find(item => item.value === around.info.lastValue)
				: entries.find(item => item.text === shown)

		if (chosen === undefined)
			return setControl(context, around, placeholderText(partOf(context), around.holder, around.info), {
				...next,
				value: null,
				placeholder: true
			})

		return setControl(context, around, chosen.text, { ...next, value: chosen.value, placeholder: false })
	}
}

const date: StoryCommandHandler<"control.date"> = {
	enabled(context) {
		return editable(controlAt(context), isDate)
	},
	run(context, command) {
		const around = controlAt(context)

		if (!editable(around, isDate) || around.info.date === null) return null

		const format = around.info.date
		const shown = formatControlDate(command.iso, format.format, format.lid, format.calendar)

		return setControl(context, around, shown, { ...(controlState(around.holder) ?? {}), date: command.iso, placeholder: false })
	}
}

const clear: StoryCommandHandler<"control.clear"> = {
	enabled(context) {
		const around = controlAt(context)

		return editable(around, clearable) && !around.info.showingPlaceholder
	},
	run(context) {
		const around = controlAt(context)

		return editable(around, clearable) ? showPlaceholder(context, around) : null
	}
}

const text: StoryCommandHandler<"control.text"> = {
	enabled(context) {
		const field = legacyOf(context, "FORMTEXT")

		return field !== undefined ? typableField(field.field) : editable(controlAt(context), isPlainText)
	},
	run(context, command) {
		const field = legacyOf(context, "FORMTEXT")

		if (field !== undefined) {
			const value = legacyText(field.field, command.text)

			return value === null ? null : setLegacy(context, field, { text: value }, value === "" ? EMPTY_FORM_TEXT : value)
		}

		const around = controlAt(context)

		if (!editable(around, isPlainText)) return null
		if (command.text === "") return showPlaceholder(context, around)

		// A plain text control without w:multiLine holds one line.
		const value = around.info.multiLine ? command.text : command.text.replace(/\n/g, " ")

		return setControl(context, around, value, { ...(controlState(around.holder) ?? {}), placeholder: false })
	}
}

// ---- new controls ---------------------------------------------------------------------------------------

const W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
const W15 = "http://schemas.microsoft.com/office/word/2012/wordml"

// Word's first entry of a new drop-down list or combo box, written value-only (<w:listItem w:value="Choose an
// item."/>): choosing it shows the placeholder again.
const CHOOSE_AN_ITEM = { text: "Choose an item.", value: "Choose an item.", valueOnly: true } as const

// The short date picture Word gives a new date control in `language` (w:lid): the language's numeric date with a
// four-digit year, Latin digits and the Gregorian calendar (en-US "M/d/yyyy", de-DE "dd.MM.yyyy", en-GB
// "dd/MM/yyyy", ja-JP "yyyy/MM/dd").
export function shortDatePicture(language: string): string {
	return numericDatePicture(language)
}

// The language of the text at the selection (its w:lang, Latin script), en-US without one.
function selectionLanguage(context: StoryCommandContext): string {
	const session = context.session
	const { $from } = context.state.selection

	if (!$from.parent.isTextblock) return "en-US"

	const props = session.formats.runProps(caretMarks(context.state, session.formats))
	const language = context.context.resolver.run(session.formats.paragraph($from.parent), props).lang.latin

	return language === undefined || language === null || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) ? "en-US" : language
}

// Where an inline control can go: a selection within one paragraph, not inside an inline control (a caret at
// one's edge is outside it) nor in a block one that is not typed into.
function inlineSpot(part: StoryPart, state: EditorState, controls: boolean): boolean {
	const { $from, $to, from, to } = state.selection

	if (!$from.parent.inlineContent || !$from.sameParent($to)) return false
	if (!controls) return true

	const inline = inlineControlAround(part, state.doc, from, to)

	if (inline !== undefined && (from !== to || (from > inline.from && from < inline.to))) return false

	const block = blockControlAround(part, state.doc, from, to)

	return block === undefined || typeable(block.info) === undefined
}

// The blocks of one container the selection covers, for a repeating section around them. `scan`: also make sure
// none of them must stay outside a control (asked when the command runs: a snapshot only looks at the range).
function blockSpot(part: StoryPart, state: EditorState, scan: boolean): { from: number; to: number } | undefined {
	const { $from, $to } = state.selection
	const range = $from.blockRange($to)

	if (range === null) return undefined

	const parent = range.parent

	if (parent.type !== nodes.doc && parent.type !== nodes.table_cell && parent.type !== nodes.sdt) return undefined
	if (parent.type === nodes.sdt) {
		const around = controlAround(part, state.doc, range.start, range.end)

		if (around === undefined || typeable(around.info) !== undefined) return undefined
	}

	if (!scan) return { from: range.start, to: range.end }

	for (let index = range.startIndex; index < range.endIndex; index++) {
		const child = parent.child(index)

		// A section break or a locked island keeps its place outside any control.
		if (child.type === nodes.locked_block || (child.attrs["sectPr"] ?? NO_SOURCE) !== NO_SOURCE) return undefined
	}

	return { from: range.start, to: range.end }
}

// Whether a part declares a namespace at its root (new w14/w15 elements need it, as Word's parts have it).
function declares(part: StoryPart, uri: string): boolean {
	const root = part.document.documentElement()

	return root >= 0 && part.reader.namespaces.prefixFor(root, uri) !== undefined
}

function madeControl(
	kind: Exclude<DocxControlKind, "repeatingSection">,
	language: string,
	items?: readonly { text: string; value: string }[]
): MadeControl {
	const id = newControlId()

	switch (kind) {
		case "dropDownList":
		case "comboBox":
			return {
				type: kind,
				id,
				items: [
					...((items ?? []).some(item => item.value === CHOOSE_AN_ITEM.value || item.text === CHOOSE_AN_ITEM.text)
						? []
						: [CHOOSE_AN_ITEM]),
					...(items ?? [])
				]
			}
		case "date":
			return { type: kind, id, dateFormat: shortDatePicture(language), lid: language }
		default:
			return { type: kind, id }
	}
}

function selectedDrawing(state: EditorState): boolean {
	const selection = state.selection

	return selection instanceof NodeSelection && selection.node.type === nodes.drawing
}

// The `type` attribute of a control mark or node (as the builder reads w:sdtPr: "text" for plain text).
function typeAttr(kind: DocxControlKind | "repeatingSectionItem"): string {
	return kind === "plainText" ? "text" : kind
}

const insert: StoryCommandHandler<"control.insert"> = {
	enabled(context) {
		const part = partOf(context)

		return inlineSpot(part, context.state, mayHoldControls(context.session)) || blockSpot(part, context.state, false) !== undefined
	},
	run(context, command) {
		const part = partOf(context)
		const state = context.state
		const session = context.session
		const kind = command.kind

		if (kind === "repeatingSection") return insertRepeating(context)
		if (command.items !== undefined && !distinctItems(command.items)) return null
		if (!inlineSpot(part, state, mayHoldControls(session)) || (kind === "checkbox" && !declares(part, W14))) return null
		if (kind === "picture" && !selectedDrawing(state)) return null

		const definition = madeControl(kind, selectionLanguage(context), command.items)
		const selection = state.selection
		const tr = state.tr

		// A picture control around the selected picture; a text control around selected text.
		if (kind === "picture" || (!selection.empty && (kind === "richText" || kind === "plainText"))) {
			tr.addMark(
				selection.from,
				selection.to,
				marks.content_control.create({ src: NO_SOURCE, type: typeAttr(kind), state: { made: definition, placeholder: false } })
			)

			return formCommand(tr, session, true)
		}

		const base = selection.empty ? caretMarks(state, session.formats) : (selection.$from.marksAcross(selection.$to) ?? [])
		const cleaned = base.filter(mark => mark.type !== marks.content_control && mark.type !== marks.link)
		const info = controlOf(part, marks.content_control.create({ src: NO_SOURCE, state: { made: definition } }))

		if (info === undefined) return null

		const checkbox = info.checkbox
		const mark = marks.content_control.create({
			src: NO_SOURCE,
			type: typeAttr(kind),
			state: checkbox !== null ? { made: definition, checked: false, placeholder: false } : { made: definition, placeholder: true }
		})
		let content: Node[]

		if (checkbox !== null) {
			const glyph = checkboxGlyph(checkbox, false)

			content = textContent(glyph.text, mark.addToSet(withFont(cleaned, glyph.font)))
		} else {
			content = placeholderContent(placeholderText(part, mark, info), placeholderMarks(context.context, mark.addToSet(cleaned)))
		}

		tr.replaceWith(selection.from, selection.to, content)
		tr.setSelection(TextSelection.create(tr.doc, selection.from, selection.from + Fragment.fromArray(content).size))

		return formCommand(tr.scrollIntoView(), session, true)
	}
}

// A repeating section of one item around the selected blocks (w15:repeatingSection, MS-DOCX §2.6.1.12).
function insertRepeating(context: StoryCommandContext): Transaction | null {
	const part = partOf(context)
	const state = context.state
	const spot = blockSpot(part, state, true)

	if (spot === undefined || !declares(part, W15)) return null

	const blocks = state.doc.slice(spot.from, spot.to).content
	const item = nodes.sdt.create(
		{ type: typeAttr("repeatingSectionItem"), state: { made: { type: "repeatingSectionItem", id: newControlId() } } },
		blocks
	)
	const section = nodes.sdt.create(
		{ type: typeAttr("repeatingSection"), state: { made: { type: "repeatingSection", id: newControlId() } } },
		item
	)
	const tr = state.tr.replaceWith(spot.from, spot.to, section)

	return formCommand(tr, context.session, true)
}

// ---- repeating section items ----------------------------------------------------------------------------

interface ItemAt {
	readonly section: Node
	readonly item: Node
	readonly itemPos: number
	readonly info: ControlInfo
}

function itemAtSelection(context: StoryCommandContext): ItemAt | undefined {
	return mayHoldControls(context.session) ? itemAt(partOf(context), context.state) : undefined
}

// The repeating section item holding the selection, with its section.
function itemAt(part: StoryPart, state: EditorState): ItemAt | undefined {
	const $from = state.selection.$from

	for (let depth = $from.depth - 1; depth > 0; depth--) {
		const item = $from.node(depth + 1)
		const section = $from.node(depth)

		if (item.type !== nodes.sdt || section.type !== nodes.sdt) continue
		if (controlOf(part, item)?.type !== "repeatingSectionItem") continue

		const info = controlOf(part, section)

		if (info?.type !== "repeatingSection" || state.selection.to > $from.after(depth + 1)) return undefined

		return { section, item, itemPos: $from.before(depth + 1), info }
	}

	return undefined
}

function itemsChangeable(at: ItemAt): boolean {
	const info = at.info

	return (
		!info.fixedItems && !info.richBinding && info.binding === null && info.lock !== "contentLocked" && info.lock !== "sdtContentLocked"
	)
}

// Inline content a copied item may hold: its text and what is written from attributes.
const COPYABLE_LEAVES = new Set(["text", "tab", "break", "hyphen", "symbol", "proof_err", "rendered_break"])

// A copy of an item for a new one, its content as it is: paragraphs and controls become new ones (a control a
// copy of its source, ControlState.copy), and what may exist once (range markers, comment references, paragraph
// ids) is left out. Undefined when the item holds what a copy cannot repeat: tables, pictures and other content
// kept as source bytes, fields, controls bound to data.
function itemCopy(part: StoryPart, item: Node): Node | undefined {
	let copyable = true
	const copies = new Map<string, Mark>()
	const copyMark = (mark: Mark): Mark => {
		if (mark.type !== marks.content_control) return mark

		const own = mark.attrs["src"] as number

		if (own === NO_SOURCE) {
			copyable &&= controlState(mark)?.made !== undefined

			return mark
		}

		if (controlOf(part, mark)?.binding !== null) copyable = false

		const key = String(own)
		let copy = copies.get(key)

		if (copy === undefined) {
			copy = marks.content_control.create({
				...mark.attrs,
				src: NO_SOURCE,
				state: { ...(controlState(mark) ?? {}), copy: own, id: newControlId() }
			})
			copies.set(key, copy)
		}

		return copy
	}
	const strip = (node: Node): Node | null => {
		if (node.type === nodes.marker || node.type === nodes.comment_ref) return null

		if (node.isLeaf) {
			if (!COPYABLE_LEAVES.has(node.type.name)) copyable = false

			return node.mark(node.marks.map(copyMark))
		}

		if (node.type !== nodes.paragraph && node.type !== nodes.sdt) {
			copyable = false

			return node
		}

		const children: Node[] = []

		node.forEach(child => {
			const copy = strip(child)

			if (copy !== null) children.push(copy)
		})

		const attrs: Record<string, unknown> = { ...node.attrs, src: NO_SOURCE, before: [] }

		if (node.type === nodes.sdt) {
			const own = node.attrs["src"] as number
			const state = controlState(node)

			if (controlOf(part, node)?.binding !== null) copyable = false

			attrs["end"] = []
			attrs["state"] = own === NO_SOURCE ? state : { ...(state ?? {}), copy: own, id: newControlId() }
		} else {
			attrs["sectPr"] = NO_SOURCE
			attrs["revision"] = 0
		}

		const kept = node.marks.filter(
			mark => mark.type !== marks.para_id && mark.type !== marks.paragraph_change && mark.type !== marks.section_change
		)

		return node.type.create(attrs, children, kept)
	}
	const copy = strip(item)

	return copyable && copy !== null ? copy : undefined
}

// Whether an item can be copied, kept per item node (the same node while it is unchanged).
const copyables = new WeakMap<Node, boolean>()

function copyable(part: StoryPart, item: Node): boolean {
	let known = copyables.get(item)

	if (known === undefined) {
		known = itemCopy(part, item) !== undefined
		copyables.set(item, known)
	}

	return known
}

function removable(part: StoryPart, item: Node): boolean {
	const lock = controlOf(part, item)?.lock

	return lock !== undefined && lock !== "sdtLocked" && lock !== "sdtContentLocked"
}

const addItem: StoryCommandHandler<"control.item.add"> = {
	enabled(context) {
		const at = itemAtSelection(context)

		return at !== undefined && itemsChangeable(at) && copyable(partOf(context), at.item)
	},
	run(context) {
		const at = itemAt(partOf(context), context.state)
		const copy = at === undefined || !itemsChangeable(at) ? undefined : itemCopy(partOf(context), at.item)

		if (at === undefined || copy === undefined) return null

		const after = at.itemPos + at.item.nodeSize
		const tr = context.state.tr.insert(after, copy)

		tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))

		return formCommand(tr.scrollIntoView(), context.session)
	}
}

const removeItem: StoryCommandHandler<"control.item.remove"> = {
	enabled(context) {
		const at = itemAtSelection(context)

		return at !== undefined && itemsChangeable(at) && at.section.childCount > 1 && removable(partOf(context), at.item)
	},
	run(context) {
		const part = partOf(context)
		const at = itemAt(part, context.state)

		if (at === undefined || !itemsChangeable(at) || at.section.childCount < 2 || !removable(part, at.item)) return null

		const tr = context.state.tr.delete(at.itemPos, at.itemPos + at.item.nodeSize)

		tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at.itemPos, tr.doc.content.size))))

		return formCommand(tr.scrollIntoView(), context.session)
	}
}

export const FORM_HANDLERS: FeatureHandlers = {
	story: {
		"control.check": check,
		"control.choose": choose,
		"control.date": date,
		"control.clear": clear,
		"control.text": text,
		"control.insert": insert,
		"control.items": items,
		"control.item.add": addItem,
		"control.item.remove": removeItem
	}
}
