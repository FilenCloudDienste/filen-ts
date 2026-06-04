import { useTranslation } from "react-i18next"
import useContactsQuery from "@/features/contacts/queries/useContacts.query"
import useContactRequestsQuery from "@/features/contacts/queries/useContactRequests.query"
import { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
import { type SelectOptions } from "@/features/contacts/contactsSelect"
import { buildContactSections, filterContactSections } from "@/features/contacts/utils"

export function useContactSections({
	searchQuery,
	selectOptions
}: {
	searchQuery: string
	selectOptions: SelectOptions | null
}): {
	items: ContactListItemWithHeader[]
	contactsQuery: ReturnType<typeof useContactsQuery>
	contactRequestsQuery: ReturnType<typeof useContactRequestsQuery>
} {
	const { t } = useTranslation()
	const contactsQuery = useContactsQuery()
	const contactRequestsQuery = useContactRequestsQuery()

	const itemsSorted =
		contactsQuery.status !== "success" || contactRequestsQuery.status !== "success"
			? []
			: buildContactSections({
					data: {
						contacts: contactsQuery.data.contacts,
						blocked: contactsQuery.data.blocked,
						incoming: contactRequestsQuery.data.incoming,
						outgoing: contactRequestsQuery.data.outgoing
					},
					headerTitles: {
						requests: t("contacts_requests"),
						pending: t("contacts_pending"),
						contacts: t("contact_contacts"),
						blocked: t("contact_blocked")
					},
					selectOptions
				})

	const items = filterContactSections({
		items: itemsSorted,
		searchQuery
	})

	return {
		items,
		contactsQuery,
		contactRequestsQuery
	}
}

export default useContactSections
