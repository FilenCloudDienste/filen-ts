import {
	controlAround,
	controlKey,
	legacyFieldOf,
	typableField,
	typeable,
	type ControlInfo,
	type ControlType,
	type LegacyField
} from "../../forms/controls"
import { enclosingBookmark } from "../../fields/bookmarks"
import { partHasBindings, unmappedKeys } from "../../forms/binding"
import { selectedField } from "../handlers/forms"
import { mayHoldControls, mayHoldFields } from "../invariants/forms"
import { protectionOf, type DocxProtectionMode } from "../protection"
import { NO_SOURCE } from "../schema"
import type { DocxEditorSession } from "../session"
import type { SnapshotInput } from "./index"

// The content control (or legacy form field) the selection is in: its type, state and choices, read from the
// selection's paragraph and ancestors only (a part without controls or fields is not looked at), and the same
// object while the answer is.

export interface DocxControlContext {
	// A content control, or a legacy form field (FORMTEXT, FORMCHECKBOX, FORMDROPDOWN).
	readonly kind: "control" | "field"
	// "textInput" for a legacy text field.
	readonly type: ControlType | "textInput"
	// w:alias (the title Word shows) and w:tag; a legacy field's bookmark name as its tag.
	readonly title: string | null
	readonly tag: string | null
	readonly checked: boolean | null
	// List entries: display text and value (a legacy drop-down's entries are both).
	readonly items: readonly { readonly text: string; readonly value: string }[]
	readonly value: string | null
	// ISO date of a date control, and the Word date picture it is shown with.
	readonly date: string | null
	readonly dateFormat: string | null
	readonly placeholder: boolean
	// Why its content cannot be changed: locked (w:lock), bound to data the editor cannot update, a field
	// that is not enabled; null when it can.
	readonly locked: "contentLocked" | "bound" | "disabled" | null
	// The control itself may not be deleted (w:lock sdtLocked or sdtContentLocked).
	readonly undeletable: boolean
	// The document's protection mode (forms: only controls and fields change).
	readonly protection: DocxProtectionMode
	// A legacy text field's w:textInput w:type ("regular", "number", "date"...) and w:maxLength (null: none).
	readonly textType: string | null
	readonly maxLength: number | null
}

const previous = new WeakMap<DocxEditorSession, { key: string; info: ControlInfo | LegacyField; context: DocxControlContext }>()

function contextOfControl(info: ControlInfo, protection: DocxProtectionMode): DocxControlContext {
	const blocker = typeable(info)

	return Object.freeze({
		kind: "control",
		type: info.type,
		title: info.alias,
		tag: info.tag,
		checked: info.checkbox?.checked ?? null,
		items: info.items,
		value: info.lastValue,
		date: info.date?.iso ?? null,
		dateFormat: info.date?.format ?? null,
		placeholder: info.showingPlaceholder,
		locked: blocker === "contentLocked" || blocker === "bound" ? blocker : null,
		undeletable: info.lock === "sdtLocked" || info.lock === "sdtContentLocked",
		protection,
		textType: null,
		maxLength: null
	})
}

const LEGACY_TYPES = { FORMTEXT: "textInput", FORMCHECKBOX: "checkbox", FORMDROPDOWN: "dropDownList" } as const

// `tag`: the bookmark the field names (w:name) where it has one: a copy keeps the name but not the bookmark,
// which stays with the original (Word shows a copy's bookmark empty).
function contextOfField(field: LegacyField, result: string, tag: string | null, protection: DocxProtectionMode): DocxControlContext {
	return Object.freeze({
		kind: "field",
		type: LEGACY_TYPES[field.type],
		title: null,
		tag,
		checked: field.type === "FORMCHECKBOX" ? field.checked : null,
		items: Object.freeze(field.entries.map(entry => Object.freeze({ text: entry, value: entry }))),
		value: field.type === "FORMDROPDOWN" ? (field.entries[field.result] ?? null) : field.type === "FORMTEXT" ? result : null,
		date: null,
		dateFormat: null,
		placeholder: false,
		// A text field Word fills in itself (a date, a calculation) is not typed into.
		locked: field.enabled && (field.type !== "FORMTEXT" || typableField(field)) ? null : "disabled",
		undeletable: false,
		protection,
		textType: field.type === "FORMTEXT" ? field.textType : null,
		maxLength: field.type === "FORMTEXT" && field.maxLength > 0 ? field.maxLength : null
	})
}

export function controlOf(input: SnapshotInput): DocxControlContext | null {
	const session = input.session
	const part = session.story.part

	if (!mayHoldControls(session) && !mayHoldFields(session)) return null

	// Which bindings map to a node is read in the background from the first look at a story with controls.
	if (partHasBindings(part)) unmappedKeys(input.context)

	const state = input.state
	const selection = state.selection
	const protection = protectionOf(input.context).mode
	const last = previous.get(session)
	const around = mayHoldControls(session) ? controlAround(part, state.doc, selection.from, selection.to) : undefined

	if (around !== undefined) {
		const key = controlKey(around.holder)

		if (last?.key === key && last.info === around.info && last.context.protection === protection) return last.context

		const context = contextOfControl(around.info, protection)

		previous.set(session, { key, info: around.info, context })

		return context
	}

	const at = mayHoldFields(session) ? selectedField(part, state) : undefined
	const field = at === undefined ? undefined : legacyFieldOf(part, at.node)

	if (at === undefined || field === undefined) return null

	const own = at.node.attrs["src"] as number
	// A copy (no source) by where it is.
	const key = own === NO_SOURCE ? `c${String(at.pos)}` : `f${String(own)}`
	const result = at.node.attrs["result"] as string

	if (
		last?.key === key &&
		last.context.protection === protection &&
		last.context.value === (field.type === "FORMTEXT" ? result : last.context.value) &&
		sameField(last.info, field)
	)
		return last.context

	const name = field.name
	const tag = own !== NO_SOURCE && name !== null && enclosingBookmark(part, own, at.node.attrs["end"] as number, name) ? name : null
	const context = contextOfField(field, result, tag, protection)

	previous.set(session, { key, info: field, context })

	return context
}

function sameField(a: ControlInfo | LegacyField, b: LegacyField): boolean {
	return (
		"entries" in a &&
		a.entries === b.entries &&
		a.name === b.name &&
		a.checked === b.checked &&
		a.result === b.result &&
		a.enabled === b.enabled
	)
}
