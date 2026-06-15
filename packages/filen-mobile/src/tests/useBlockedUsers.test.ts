// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, cleanup } from "@testing-library/react"

// Mirrors TanStack's invariant: success ⟹ data defined; with no data the status is pending.
const queryHolder = {
	data: undefined as { contacts: unknown[]; blocked: unknown[] } | undefined,
	status: "pending" as "pending" | "success"
}

vi.mock("@/features/contacts/queries/useContacts.query", () => ({
	default: () => queryHolder,
	useContactsQuery: () => queryHolder
}))

import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"

beforeEach(() => {
	cleanup()
	queryHolder.data = undefined
	queryHolder.status = "pending"
})

describe("useBlockedUsers", () => {
	it("returns an empty set when the query has not settled", () => {
		const { result } = renderHook(() => useBlockedUsers())

		expect(result.current.userIds.size).toBe(0)
		expect(result.current.emails.size).toBe(0)
	})

	it("derives the blocked sets from query data", () => {
		queryHolder.data = {
			contacts: [],
			blocked: [{ uuid: "u1", userId: 10n, email: "a@x.com", avatar: undefined, nickName: "A", timestamp: 1n }]
		}
		queryHolder.status = "success"

		const { result } = renderHook(() => useBlockedUsers())

		expect(result.current.userIds.has(10n)).toBe(true)
		expect(result.current.emails.has("a@x.com")).toBe(true)
	})
})
