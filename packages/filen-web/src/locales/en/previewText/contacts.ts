// "preview" namespace, text family — a contact file's cards. Spread into preview.ts; same catalog rules.
export const previewTextContacts = {
	/** Contacts preview — the view switch's group name (Contacts | Source) */
	previewContactsView: "Contacts view",
	/** Contacts preview — the view switch's option that shows the cards */
	previewContactsCards: "Contacts",
	/** Contacts preview — the list's accessible name and count; {{count}} contacts */
	previewContactsCount_one: "{{count}} contact",
	/** Contacts preview — the list's accessible name and count; {{count}} contacts */
	previewContactsCount_other: "{{count}} contacts",
	/** Contacts preview — appended to the count when cards past the cap are not shown; {{count}} of them */
	previewContactsOmitted_one: "{{count}} more not shown",
	/** Contacts preview — appended to the count when cards past the cap are not shown; {{count}} of them */
	previewContactsOmitted_other: "{{count}} more not shown",
	/** Contacts preview — appended to the count when the file was too long to read to its end; {{count}} cards past the cap were seen before reading stopped, so more may follow */
	previewContactsOmittedAtLeast_one: "at least {{count}} more not shown",
	/** Contacts preview — appended to the count when the file was too long to read to its end; {{count}} cards past the cap were seen before reading stopped, so more may follow */
	previewContactsOmittedAtLeast_other: "at least {{count}} more not shown",
	/** Contacts preview — appended to the count when the file was too long to read to its end and no card past the cap was seen */
	previewContactsTruncated: "the rest of the file was not read",
	/** Contacts preview — the file has no cards */
	previewContactsEmpty: "This file has no contacts.",
	/** Contacts preview — reading the contacts failed */
	previewContactsFailed: "The contacts could not be read.",
	/** Contacts preview — a card that names no one */
	previewContactsUnnamed: "No name",
	/** Contacts preview — field: a phone number (its types follow, if any) */
	previewContactsPhone: "Phone",
	/** Contacts preview — field: an email address */
	previewContactsEmail: "Email",
	/** Contacts preview — field: a postal address */
	previewContactsAddress: "Address",
	/** Contacts preview — field: a web address, shown as text and never opened */
	previewContactsWebsite: "Website",
	/** Contacts preview — field: the birthday */
	previewContactsBirthday: "Birthday",
	/** Contacts preview — field: the nickname */
	previewContactsNickname: "Nickname",
	/** Contacts preview — field: the note */
	previewContactsNote: "Note",
	/** Contacts preview — a field's label with its types; {{label}} is the field (Phone), {{types}} its types (work, cell) */
	previewContactsTyped: "{{label}} ({{types}})"
}
