import type { Contact } from "@filen/sdk-rs"

// The selected contacts in source-list order. A selected uuid no longer in `contacts` (removed between
// selection and submit) is dropped rather than carried into the action.
export function resolveSelectedContacts(contacts: Contact[], selected: ReadonlySet<string>): Contact[] {
	return contacts.filter(contact => selected.has(contact.uuid))
}
