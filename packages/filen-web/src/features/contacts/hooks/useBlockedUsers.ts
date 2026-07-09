import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { deriveBlockedUsers, type BlockedUsers } from "@/features/contacts/lib/blocking"

// Reactive blocked-user lookup for the sharedIn block filter (see
// features/drive/components/directoryListing.logic.ts) — mirrors filen-mobile's useBlockedUsers. React
// Compiler memoizes the derivation, keyed on the query's blocked array reference, so this needs no
// hand-written useMemo. An unsettled/empty/disabled query derives to EMPTY_BLOCKED_USERS via
// deriveBlockedUsers's own empty-array behavior — no separate pending branch needed.
//
// `enabled` gates the underlying contacts fetch itself (queries/contacts.ts's useContactsQuery), not
// just this derivation — only the sharedIn variant filters by the blocked set, so
// directoryListing.tsx passes false for every other variant to skip the getContacts/
// getBlockedContacts worker round trip on mount and on every window refocus. A disabled query's data
// is undefined, which still derives to the fail-open EMPTY_BLOCKED_USERS above.
export function useBlockedUsers(enabled: boolean): BlockedUsers {
	return deriveBlockedUsers(useContactsQuery({ enabled }).data?.blocked ?? [])
}
