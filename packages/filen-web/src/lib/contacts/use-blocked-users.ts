import { useContactsQuery } from "@/queries/contacts"
import { deriveBlockedUsers, type BlockedUsers } from "@/lib/contacts/blocking"

// Reactive blocked-user lookup for the sharedIn block filter (see
// components/drive/directory-listing.logic.ts) — mirrors filen-mobile's useBlockedUsers. React
// Compiler memoizes the derivation, keyed on the query's blocked array reference, so this needs no
// hand-written useMemo. An unsettled/empty query derives to EMPTY_BLOCKED_USERS via deriveBlockedUsers's
// own empty-array behavior — no separate pending branch needed.
export function useBlockedUsers(): BlockedUsers {
	return deriveBlockedUsers(useContactsQuery().data?.blocked ?? [])
}
