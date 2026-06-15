import useContactsQuery from "@/features/contacts/queries/useContacts.query"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/blockedSelectors"

// Reactive blocked-user lookup. The React Compiler memoizes the derivation keyed on the
// query's blocked array, so consumers get a stable value until the blocked list changes.
export function useBlockedUsers(): BlockedUsers {
	const contactsQuery = useContactsQuery({
		enabled: false
	})

	if (contactsQuery.status !== "success") {
		return EMPTY_BLOCKED_USERS
	}

	return deriveBlockedUsers(contactsQuery.data.blocked)
}

export default useBlockedUsers
