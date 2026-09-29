// Identity sets for the blocked-user filter used across drive shares, chats and notes —
// userId is the primary key (stable across an email change); emails is a lowercased,
// trimmed fallback for callers that only have a shared item's email.
export type BlockedUsers = {
	userIds: ReadonlySet<bigint>
	emails: ReadonlySet<string>
}

export const EMPTY_BLOCKED_USERS: BlockedUsers = Object.freeze({
	userIds: new Set<bigint>(),
	emails: new Set<string>()
}) as BlockedUsers

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

export function deriveBlockedUsers(blocked: readonly { userId: bigint; email: string }[]): BlockedUsers {
	const userIds = new Set<bigint>()
	const emails = new Set<string>()

	for (const contact of blocked) {
		userIds.add(contact.userId)
		emails.add(normalizeEmail(contact.email))
	}

	return { userIds, emails }
}

// userId checked first, email checked only as a fallback. Both identity fields are optional on the
// caller's side: a resolved shared-item identity always carries both, but this stays permissive for
// any future caller that only has one of the two.
export function isBlocked(identity: { userId?: bigint; email?: string }, blocked: BlockedUsers): boolean {
	if (identity.userId !== undefined && blocked.userIds.has(identity.userId)) {
		return true
	}

	if (identity.email !== undefined && blocked.emails.has(normalizeEmail(identity.email))) {
		return true
	}

	return false
}
