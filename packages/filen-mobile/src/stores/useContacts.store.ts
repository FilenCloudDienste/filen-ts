import { create } from "zustand"
import type { Contact, BlockedContact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

export type ContactListItem =
	| {
			type: "blocked"
			data: BlockedContact
	  }
	| {
			type: "incomingRequest"
			data: ContactRequestIn
	  }
	| {
			type: "outgoingRequest"
			data: ContactRequestOut
	  }
	| {
			type: "contact"
			data: Contact
	  }

export type ContactListItemWithHeader =
	| ContactListItem
	| {
			type: "header"
			data: {
				id: "contacts" | "blocked" | "requests" | "pending"
				title: string
			}
	  }

export type ContactsStore = {
	selectedContacts: ContactListItem[]
	setSelectedContacts: (fn: ContactListItem[] | ((prev: ContactListItem[]) => ContactListItem[])) => void
}

export const useContactsStore = create<ContactsStore>(set => ({
	selectedContacts: [],
	setSelectedContacts(fn) {
		set(state => ({
			selectedContacts: typeof fn === "function" ? fn(state.selectedContacts) : fn
		}))
	}
}))

export default useContactsStore
