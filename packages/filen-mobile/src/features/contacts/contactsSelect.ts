import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { randomUUID } from "expo-crypto"
import events from "@/lib/events"
import { serialize, deserialize } from "@/lib/serializer"
import type { Contact as TContact } from "@filen/sdk-rs"
import useContactsStore from "@/features/contacts/store/useContacts.store"
import logger from "@/lib/logger"

export type SelectOptions = {
	id: string
	multiple: boolean
	userIdsToExclude: number[]
}

export async function selectContacts(options: Omit<SelectOptions, "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedContacts: TContact[]
	  }
> {
	return new Promise(resolve => {
		const id = randomUUID()

		// Ensure clean state when entering picker mode. If the user had bulk
		// mode active before (long-press → Select on the standalone contacts
		// screen), the picker would otherwise render checkboxes on the first
		// paint with stale bulk state. clearSelectedContacts() resets BOTH
		// selectedContacts and bulkMode.
		useContactsStore.getState().clearSelectedContacts()

		const sub = events.subscribe("contactsSelect", data => {
			if (data.id === id) {
				sub.remove()

				if (data.cancelled || data.selectedContacts.length === 0) {
					resolve({
						cancelled: true
					})

					return
				}

				resolve({
					cancelled: false,
					selectedContacts: data.selectedContacts
				})
			}
		})

		router.push({
			pathname: "/contacts",
			params: {
				selectOptions: serialize({
					...options,
					id
				} satisfies SelectOptions)
			}
		})
	})
}

export function useSelectOptions() {
	const searchParams = useLocalSearchParams<{
		selectOptions?: string
	}>()

	const selectOptions = ((): SelectOptions | null => {
		if (searchParams && searchParams.selectOptions) {
			try {
				const parsed = deserialize(searchParams.selectOptions) as SelectOptions

				return {
					multiple: parsed.multiple,
					id: parsed.id,
					// Default to [] so a stale/legacy serialized param missing this field can never reach
					// render as undefined (consumers call .some/.includes on it synchronously).
					userIdsToExclude: parsed.userIdsToExclude ?? []
				}
			} catch (e) {
				logger.error("contacts-select", "Failed to deserialize selectOptions param", { error: e instanceof Error ? e.message : String(e) })

				return null
			}
		}

		return null
	})()

	return selectOptions
}
