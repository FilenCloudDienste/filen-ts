import { contactsQueryGet, useContactsQuery, type ContactsQueryData } from "@/features/contacts/queries/contacts"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"

// Reactive blocked-user lookup — mirrors filen-mobile's useBlockedUsers. React Compiler memoizes the
// derivation, keyed on the query's blocked array reference, so this needs no hand-written useMemo. An
// unsettled/empty/disabled query returns the shared EMPTY_BLOCKED_USERS: a fresh `[]` fallback would miss
// that memo every render and hand consumers keyed on this value a new object each time.
//
// `enabled` gates the underlying contacts fetch itself (queries/contacts.ts's useContactsQuery), not just
// this derivation. Each surface that needs a live blocked set enables it once at its own top level —
// directoryListing for the sharedIn variant, notesSidebar, chatsSidebar, messageThread — and threads the
// value down as props, so no row or menu opens its own observer. Multiple enabled surfaces share one
// query key: the fetch is deduped, so an extra observer is not an extra request. A disabled query's data
// is undefined, which still yields the fail-open EMPTY_BLOCKED_USERS above.
export function useBlockedUsers(enabled: boolean): BlockedUsers {
	return blockedUsersOf(useContactsQuery({ enabled }).data?.blocked)
}

function blockedUsersOf(blocked: ContactsQueryData["blocked"] | undefined): BlockedUsers {
	return blocked === undefined || blocked.length === 0 ? EMPTY_BLOCKED_USERS : deriveBlockedUsers(blocked)
}

// The same set as the contacts cache holds it now, for a reader outside React; never a fetch, fail-open.
export function heldBlockedUsers(): BlockedUsers {
	return blockedUsersOf(contactsQueryGet()?.blocked)
}
