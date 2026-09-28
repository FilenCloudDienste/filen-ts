// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"

const query = vi.hoisted(() => ({ data: undefined as { blocked: { userId: bigint; email: string }[] } | undefined }))

vi.mock("@/features/contacts/queries/contacts", () => ({ useContactsQuery: () => query }))

describe("useBlockedUsers", () => {
	// Consumers memoize listing filters on this value, so a new object per render re-runs them per render.
	it("keeps one identity across renders while contacts has no data", () => {
		query.data = undefined

		const { result, rerender } = renderHook(() => useBlockedUsers(true))
		const first = result.current

		rerender()

		expect(first).toBe(EMPTY_BLOCKED_USERS)
		expect(result.current).toBe(first)
	})

	it("derives the blocked set once contacts has data", () => {
		query.data = { blocked: [{ userId: 7n, email: " Blocked@X.com " }] }

		const { result } = renderHook(() => useBlockedUsers(true))

		expect(result.current.userIds.has(7n)).toBe(true)
		expect(result.current.emails.has("blocked@x.com")).toBe(true)
	})
})
