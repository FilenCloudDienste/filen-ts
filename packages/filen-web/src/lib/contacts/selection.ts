import { type ContactSection } from "@/components/contacts/contacts-list.logic"

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
