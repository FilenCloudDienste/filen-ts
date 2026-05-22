import { create } from "zustand"
import type { Contact, BlockedContact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { toggleInArray } from "@/stores/createSelectionSlice"

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
	/**
	 * Distinguishes "picker mode" (selectOptions !== null in route, tap-to-select,
	 * existing flow) from "bulk-action mode" (long-press / Select-menu entry,
	 * header bulk actions). Picker mode never sets this — only the in-app
	 * route does on user gesture.
	 */
	bulkMode: boolean
	setSelectedContacts: (fn: ContactListItem[] | ((prev: ContactListItem[]) => ContactListItem[])) => void
	setBulkMode: (next: boolean) => void
	toggleSelectedContact: (item: ContactListItem) => void
	clearSelectedContacts: () => void
	selectAllContacts: (items: ContactListItem[]) => void
}

const contactItemId = (i: ContactListItem) => `${i.type}:${i.data.uuid}`

export const useContactsStore = create<ContactsStore>(set => ({
	selectedContacts: [],
	bulkMode: false,
	setSelectedContacts(fn) {
		set(state => ({
			selectedContacts: typeof fn === "function" ? fn(state.selectedContacts) : fn
		}))
	},
	setBulkMode(next) {
		set({ bulkMode: next })
	},
	toggleSelectedContact(item) {
		set(state => ({
			selectedContacts: toggleInArray(state.selectedContacts, item, contactItemId)
		}))
	},
	clearSelectedContacts() {
		set({ selectedContacts: [], bulkMode: false })
	},
	selectAllContacts(items) {
		set({ selectedContacts: items })
	}
}))

export default useContactsStore
