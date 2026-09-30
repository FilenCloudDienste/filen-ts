import { create } from "zustand"
import type { Contact, BlockedContact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { toggleInArray } from "@filen/shared"

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
	setBulkMode: (next: boolean) => void
	toggleSelectedContact: (item: ContactListItem) => void
	clearSelectedContacts: () => void
}

const contactItemId = (i: ContactListItem) => `${i.type}:${i.data.uuid}`

export const useContactsStore = create<ContactsStore>(set => ({
	selectedContacts: [],
	bulkMode: false,
	setBulkMode(next) {
		set({ bulkMode: next })
	},
	toggleSelectedContact(item) {
		set(state => {
			const selectedContacts = toggleInArray(state.selectedContacts, item, contactItemId)

			return {
				selectedContacts,
				// Auto-exit bulk mode once the last item is deselected, so selection-mode UI
				// (row checkboxes / the bulk header) never lingers with nothing selected.
				bulkMode: selectedContacts.length === 0 ? false : state.bulkMode
			}
		})
	},
	clearSelectedContacts() {
		set({ selectedContacts: [], bulkMode: false })
	}
}))

export default useContactsStore
