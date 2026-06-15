import { type BlockedContact } from "@filen/sdk-rs"

export type BlockedUsers = {
	userIds: ReadonlySet<bigint>
	emails: ReadonlySet<string>
}

export const EMPTY_BLOCKED_USERS: BlockedUsers = Object.freeze({
	userIds: new Set<bigint>(),
	emails: new Set<string>()
}) as BlockedUsers

export function deriveBlockedUsers(blocked: readonly BlockedContact[]): BlockedUsers {
	const userIds = new Set<bigint>()
	const emails = new Set<string>()

	for (const b of blocked) {
		userIds.add(b.userId)
		emails.add(b.email.trim().toLowerCase())
	}

	return {
		userIds,
		emails
	}
}

export function isBlocked(identity: { userId?: bigint; email?: string }, blocked: BlockedUsers): boolean {
	if (identity.userId !== undefined && blocked.userIds.has(identity.userId)) {
		return true
	}

	if (identity.email !== undefined && blocked.emails.has(identity.email.trim().toLowerCase())) {
		return true
	}

	return false
}
