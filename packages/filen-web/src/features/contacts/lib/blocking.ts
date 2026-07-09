import type { BlockedContact } from "@filen/sdk-rs"

// Identity sets for the sharedIn block filter (see features/drive/components/directoryListing.logic.ts) —
// ports filen-mobile's blockedSelectors. userId is the primary key (stable across an email change);
// emails is a lowercased, trimmed fallback for callers that only have a shared item's email.
export interface BlockedUsers {
	userIds: ReadonlySet<bigint>
	emails: ReadonlySet<string>
}

export const EMPTY_BLOCKED_USERS: BlockedUsers = Object.freeze({
	userIds: new Set<bigint>(),
	emails: new Set<string>()
})

export function deriveBlockedUsers(blocked: readonly BlockedContact[]): BlockedUsers {
	const userIds = new Set<bigint>()
	const emails = new Set<string>()

	for (const contact of blocked) {
		userIds.add(contact.userId)
		emails.add(contact.email.trim().toLowerCase())
	}

	return { userIds, emails }
}

// userId checked first, email checked only as a fallback (trimmed + lowercased, matching how
// deriveBlockedUsers populates the set) — mirrors filen-mobile's isBlocked exactly. Both identity
// fields are optional on the caller's side: a resolved shared-item identity always carries both,
// but this stays permissive for any future caller that only has one of the two.
export function isBlocked(identity: { userId?: bigint; email?: string }, blocked: BlockedUsers): boolean {
	if (identity.userId !== undefined && blocked.userIds.has(identity.userId)) {
		return true
	}

	if (identity.email !== undefined && blocked.emails.has(identity.email.trim().toLowerCase())) {
		return true
	}

	return false
}
