import type { Contact } from "@filen/sdk-rs"

// Selection helpers for every contact picker: a flat Set of selected contact uuids (single-section,
// unlike the contacts page, whose ContactSelection keeps one Set per section).

// Add if absent, remove if present. Returns a new Set; the input is never mutated.
export function togglePickerContact(selected: ReadonlySet<string>, uuid: string): ReadonlySet<string> {
	const next = new Set(selected)

	if (next.has(uuid)) {
		next.delete(uuid)
	} else {
		next.add(uuid)
	}

	return next
}

// The selected contacts in source-list order. A selected uuid no longer in `contacts` (removed between
// selection and submit) is dropped rather than carried into the action.
export function resolveSelectedContacts(contacts: Contact[], selected: ReadonlySet<string>): Contact[] {
	return contacts.filter(contact => selected.has(contact.uuid))
}
