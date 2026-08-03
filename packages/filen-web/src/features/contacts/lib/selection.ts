import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { clampListboxIndex, listboxRange } from "@/features/drive/lib/listbox"
import { type ContactSection } from "@/features/contacts/components/contactsList.logic"

// Per-section selected-uuid buckets for the contacts bulk-selection mode. Unlike drive's single
// DriveItem union (stores/drive.ts), contacts has four structurally distinct row kinds (requests/
// pending/contacts/blocked) sharing no common item type, and every bulk action is inherently
// section-scoped (a "Deny" button only ever runs over the requests bucket) — one Set per section is
// both the natural data shape and exactly what the bulk bar's gating needs, with no cross-section
// uuid-collision risk to defend against.
export type ContactSectionKey = ContactSection["key"]

export type ContactSelection = Readonly<Record<ContactSectionKey, ReadonlySet<string>>>

export const EMPTY_CONTACT_SELECTION: ContactSelection = Object.freeze({
	requests: new Set<string>(),
	pending: new Set<string>(),
	contacts: new Set<string>(),
	blocked: new Set<string>()
})

export interface ContactSelectionAnchor {
	section: ContactSectionKey
	uuid: string
}

export interface ContactSelectionState {
	selection: ContactSelection
	anchor: ContactSelectionAnchor | null
}

export interface ContactPointerSelectInput {
	section: ContactSectionKey
	// The section's ordered, currently-rendered uuids (search-filtered, in render order) — shift-range
	// math walks this array's indices, exactly like useNotesListSelection walks its `notes`.
	uuids: readonly string[]
	index: number
	shift: boolean
	// Ctrl/Cmd — resolved by the caller from the real MouseEvent so this stays React-free.
	toggle: boolean
}

export const EMPTY_CONTACT_SELECTION_STATE: ContactSelectionState = Object.freeze({
	selection: EMPTY_CONTACT_SELECTION,
	anchor: null
})

export function contactSelectionSize(selection: ContactSelection): number {
	return selection.requests.size + selection.pending.size + selection.contacts.size + selection.blocked.size
}

// The account's four unfiltered record sets, keyed the way the selection is.
export interface ContactRecords {
	requests: readonly ContactRequestIn[]
	pending: readonly ContactRequestOut[]
	contacts: readonly Contact[]
	blocked: readonly BlockedContact[]
}

export interface SelectedContacts {
	requests: ContactRequestIn[]
	pending: ContactRequestOut[]
	contacts: Contact[]
	blocked: BlockedContact[]
	total: number
}

// The selection resolved against what still EXISTS. A uuid outlives its record — an accepted request or
// a removed contact leaves the query data the moment its action lands — so both the bulk bar's contents
// and the gate that mounts it read this, never the raw uuid count: gating on uuids alone floats an empty
// bar with no actions over the list. Records are unfiltered by search on purpose (a selection made before
// typing still resolves), and the lists are short and unvirtualized, so a plain filter per section is the
// whole cost.
export function resolveSelectedContacts(records: ContactRecords, selection: ContactSelection): SelectedContacts {
	const requests = records.requests.filter(request => selection.requests.has(request.uuid))
	const pending = records.pending.filter(request => selection.pending.has(request.uuid))
	const contacts = records.contacts.filter(contact => selection.contacts.has(contact.uuid))
	const blocked = records.blocked.filter(contact => selection.blocked.has(contact.uuid))

	return { requests, pending, contacts, blocked, total: requests.length + pending.length + contacts.length + blocked.length }
}

function onlySection(section: ContactSectionKey, uuids: readonly string[]): ContactSelection {
	return { ...EMPTY_CONTACT_SELECTION, [section]: new Set(uuids) }
}

// The app-wide modifier-click model (drive/notes/chats), sectioned: plain click replaces the whole
// selection with the clicked row, Ctrl/Cmd toggles it into a multi-section selection, Shift extends an
// inclusive range from the anchor. A cross-section range has no meaning here — contacts has four
// structurally distinct row kinds and every bulk action is section-scoped — so a Shift with a foreign
// or vanished anchor collapses to a plain select rather than guessing.
export function nextContactSelection(state: ContactSelectionState, input: ContactPointerSelectInput): ContactSelectionState {
	const uuid = input.uuids[input.index]

	if (uuid === undefined) {
		return state
	}

	const anchor = state.anchor
	const anchorIndex = anchor !== null && anchor.section === input.section ? input.uuids.indexOf(anchor.uuid) : -1

	if (input.shift && anchorIndex !== -1) {
		const range = listboxRange(anchorIndex, clampListboxIndex(input.index, input.uuids.length))
		const ranged: string[] = []

		for (const i of range) {
			const rangedUuid = input.uuids[i]

			if (rangedUuid !== undefined) {
				ranged.push(rangedUuid)
			}
		}

		// The anchor deliberately does NOT move: a run of consecutive Shift+clicks keeps ranging from the
		// same fixed start, exactly like useNotesListSelection.
		return { selection: onlySection(input.section, ranged), anchor }
	}

	if (input.toggle) {
		return {
			selection: toggleContactSelection(state.selection, input.section, uuid),
			anchor: { section: input.section, uuid }
		}
	}

	return { selection: onlySection(input.section, [uuid]), anchor: { section: input.section, uuid } }
}

// Add if absent, remove if present — the toggle boilerplate the row click handler builds on.
// Returns a new selection; the input is never mutated (React state-update contract).
export function toggleContactSelection(selection: ContactSelection, section: ContactSectionKey, uuid: string): ContactSelection {
	const next = new Set(selection[section])

	if (next.has(uuid)) {
		next.delete(uuid)
	} else {
		next.add(uuid)
	}

	return { ...selection, [section]: next }
}

// Drops the given uuids from one section's bucket — the post-action cleanup every confirm/bulk
// handler runs so a row that just left the listing (the action helper's own cache patch already
// removed it) can't linger as a phantom "selected" count. Returns the same reference when nothing
// changes, avoiding a pointless re-render.
export function removeFromContactSelection(
	selection: ContactSelection,
	section: ContactSectionKey,
	uuids: readonly string[]
): ContactSelection {
	if (uuids.length === 0) {
		return selection
	}

	const next = new Set(selection[section])
	let changed = false

	for (const uuid of uuids) {
		if (next.delete(uuid)) {
			changed = true
		}
	}

	if (!changed) {
		return selection
	}

	return { ...selection, [section]: next }
}
