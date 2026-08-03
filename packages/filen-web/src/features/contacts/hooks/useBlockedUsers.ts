import { useContactsQuery } from "@/features/contacts/queries/contacts"
import { deriveBlockedUsers, type BlockedUsers } from "@/features/contacts/lib/blocking"

// Reactive blocked-user lookup — mirrors filen-mobile's useBlockedUsers. React Compiler memoizes the
// derivation, keyed on the query's blocked array reference, so this needs no hand-written useMemo. An
// unsettled/empty/disabled query derives to EMPTY_BLOCKED_USERS via deriveBlockedUsers's own empty-array
// behavior — no separate pending branch needed.
//
// `enabled` gates the underlying contacts fetch itself (queries/contacts.ts's useContactsQuery), not just
// this derivation. Each surface that needs a live blocked set enables it once at its own top level —
// directoryListing for the sharedIn variant, notesSidebar, chatsSidebar, messageThread — and threads the
// value down as props, so no row or menu opens its own observer. Multiple enabled surfaces share one
// query key: the fetch is deduped, so an extra observer is not an extra request. A disabled query's data
// is undefined, which still derives to the fail-open EMPTY_BLOCKED_USERS above.
export function useBlockedUsers(enabled: boolean): BlockedUsers {
	return deriveBlockedUsers(useContactsQuery({ enabled }).data?.blocked ?? [])
}
