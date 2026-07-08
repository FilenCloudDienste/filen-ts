import { describe, expect, it } from "vitest"
import type { BlockedContact } from "@filen/sdk-rs"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, isBlocked } from "@/lib/contacts/blocking"

function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		userId: 10n,
		email: "a@x.com",
		nickName: "A",
		timestamp: 1n,
		...overrides
	}
}

const blockedFixture: BlockedContact[] = [
	mockBlockedContact(),
	mockBlockedContact({ uuid: "22222222-2222-2222-2222-222222222222", userId: 20n, email: "B@X.com", nickName: "B", timestamp: 2n })
]

describe("deriveBlockedUsers", () => {
	it("derives userId + lowercased-email sets", () => {
		const blocked = deriveBlockedUsers(blockedFixture)

		expect(blocked.userIds.has(10n)).toBe(true)
		expect(blocked.userIds.has(20n)).toBe(true)
		expect(blocked.emails.has("a@x.com")).toBe(true)
		expect(blocked.emails.has("b@x.com")).toBe(true)
	})
})

describe("isBlocked", () => {
	it("matches by userId first", () => {
		const blocked = deriveBlockedUsers(blockedFixture)

		expect(isBlocked({ userId: 10n }, blocked)).toBe(true)
		expect(isBlocked({ userId: 99n }, blocked)).toBe(false)
	})

	it("matches by email case-insensitively as a fallback", () => {
		const blocked = deriveBlockedUsers(blockedFixture)

		expect(isBlocked({ email: "B@x.COM" }, blocked)).toBe(true)
		expect(isBlocked({ email: "none@x.com" }, blocked)).toBe(false)
	})

	it("EMPTY_BLOCKED_USERS matches nothing", () => {
		expect(isBlocked({ userId: 10n, email: "a@x.com" }, EMPTY_BLOCKED_USERS)).toBe(false)
	})
})
