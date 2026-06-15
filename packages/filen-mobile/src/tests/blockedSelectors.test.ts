import { describe, it, expect } from "vitest"
import { deriveBlockedUsers, isBlocked, EMPTY_BLOCKED_USERS } from "@/features/contacts/blockedSelectors"

const blockedFixture = [
	{ uuid: "u1", userId: 10n, email: "a@x.com", avatar: undefined, nickName: "A", timestamp: 1n },
	{ uuid: "u2", userId: 20n, email: "B@X.com", avatar: undefined, nickName: "B", timestamp: 2n }
]

describe("blockedSelectors", () => {
	it("derives userId + lowercased-email sets", () => {
		const b = deriveBlockedUsers(blockedFixture as never)

		expect(b.userIds.has(10n)).toBe(true)
		expect(b.userIds.has(20n)).toBe(true)
		expect(b.emails.has("a@x.com")).toBe(true)
		expect(b.emails.has("b@x.com")).toBe(true)
	})

	it("matches by userId first", () => {
		const b = deriveBlockedUsers(blockedFixture as never)

		expect(isBlocked({ userId: 10n }, b)).toBe(true)
		expect(isBlocked({ userId: 99n }, b)).toBe(false)
	})

	it("matches by email case-insensitively as a fallback", () => {
		const b = deriveBlockedUsers(blockedFixture as never)

		expect(isBlocked({ email: "B@x.COM" }, b)).toBe(true)
		expect(isBlocked({ email: "none@x.com" }, b)).toBe(false)
	})

	it("empty constant matches nothing", () => {
		expect(isBlocked({ userId: 10n, email: "a@x.com" }, EMPTY_BLOCKED_USERS)).toBe(false)
	})
})
