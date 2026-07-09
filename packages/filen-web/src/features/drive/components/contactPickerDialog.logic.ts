import type { Contact } from "@filen/sdk-rs"

// Pure selection helpers for the contact-picker dialog — a flat Set of selected contact uuids (the
// picker is single-section, unlike the four-section contacts page whose ContactSelection buckets one
// Set per section). Kept out of the component so the selection/gating logic stays trivially testable
// without a DOM renderer (see vitest.config.ts).

// Add if absent, remove if present. Returns a new Set; the input is never mutated (React
// state-update contract).
export function togglePickerContact(selected: ReadonlySet<string>, uuid: string): ReadonlySet<string> {
	const next = new Set(selected)

	if (next.has(uuid)) {
		next.delete(uuid)
	} else {
		next.add(uuid)
	}

	return next
}

// Resolves the selected-uuid Set back to the concrete Contact records the share action needs,
// preserving the source list's order. Ignores selected uuids no longer present in `contacts` (a
// contact removed between selection and submit) rather than carrying a dangling uuid into the share.
export function resolveSelectedContacts(contacts: Contact[], selected: ReadonlySet<string>): Contact[] {
	return contacts.filter(contact => selected.has(contact.uuid))
}
