import useContactsQuery from "@/features/contacts/queries/useContacts.query"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@/features/contacts/blockedSelectors"

// Reactive blocked-user lookup. The React Compiler memoizes the derivation keyed on the
// query's blocked array, so consumers get a stable value until the blocked list changes.
export function useBlockedUsers(): BlockedUsers {
	const contactsQuery = useContactsQuery({
		enabled: false
	})

	// Read the DATA, not the last fetch's verdict: an offline refetch fails and flips `status` to
	// "error" while keeping the blocked list (#103). Gating on status answered "nobody is blocked"
	// for the whole time the device was offline, silently un-hiding blocked users' notes and chats.
	if (!contactsQuery.data) {
		return EMPTY_BLOCKED_USERS
	}

	return deriveBlockedUsers(contactsQuery.data.blocked)
}

export default useBlockedUsers
