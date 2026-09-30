import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { awaitPickerEvent } from "@/lib/awaitPickerEvent"
import { serialize, deserializeRouteParam } from "@/lib/serializer"
import type { Contact as TContact } from "@filen/sdk-rs"
import useContactsStore from "@/features/contacts/store/useContacts.store"

export type SelectOptions = {
	id: string
	userIdsToExclude?: number[]
}

export async function selectContacts(options?: Omit<SelectOptions, "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedContacts: TContact[]
	  }
> {
	// Ensure clean state when entering picker mode. If the user had bulk
	// mode active before (long-press → Select on the standalone contacts
	// screen), the picker would otherwise render checkboxes on the first
	// paint with stale bulk state. clearSelectedContacts() resets BOTH
	// selectedContacts and bulkMode.
	useContactsStore.getState().clearSelectedContacts()

	return awaitPickerEvent(
		"contactsSelect",
		id => {
			router.push({
				pathname: "/contacts",
				params: {
					selectOptions: serialize({
						...options,
						id
					} satisfies SelectOptions)
				}
			})
		},
		data =>
			data.cancelled || data.selectedContacts.length === 0
				? {
						cancelled: true
					}
				: {
						cancelled: false,
						selectedContacts: data.selectedContacts
					}
	)
}

// Reads the param string up front and parses without a try/catch, so the React Compiler memoizes the
// result on that string instead of building a fresh object every render.
export function useSelectOptions(): SelectOptions | null {
	const { selectOptions: param } = useLocalSearchParams<{
		selectOptions?: string
	}>()
	const parsed = deserializeRouteParam<SelectOptions>(param)

	if (!parsed) {
		return null
	}

	return {
		id: parsed.id,
		userIdsToExclude: parsed.userIdsToExclude
	}
}
