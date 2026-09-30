// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, cleanup, act } from "@testing-library/react"

const { holder, cache } = vi.hoisted(() => {
	const cache = {
		listener: null as ((event: { query: { queryKey: unknown[] } }) => void) | null,
		attachCount: 0,
		detachCount: 0
	}

	return {
		holder: {
			data: undefined as { contacts: unknown[]; blocked: unknown[] } | undefined
		},
		cache
	}
})

vi.mock("@/features/contacts/queries/useContacts.query", () => ({
	BASE_QUERY_KEY: "useContactsQuery",
	contactsQueryGet: () => holder.data
}))

vi.mock("@/queries/client", () => ({
	queryClient: {
		getQueryCache: () => ({
			subscribe: (listener: (event: { query: { queryKey: unknown[] } }) => void) => {
				cache.listener = listener
				cache.attachCount++

				return () => {
					cache.listener = null
					cache.detachCount++
				}
			}
		})
	}
}))

import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"

function blockedEntry(userId: bigint, email: string) {
	return { uuid: `u${userId}`, userId, email, avatar: undefined, nickName: email, timestamp: 1n }
}

function emit(queryKey: unknown[]) {
	act(() => {
		cache.listener?.({ query: { queryKey } })
	})
}

beforeEach(() => {
	cleanup()
	holder.data = undefined
	cache.attachCount = 0
	cache.detachCount = 0
})

describe("useBlockedUsers", () => {
	it("returns an empty set when nothing is cached", () => {
		const { result } = renderHook(() => useBlockedUsers())

		expect(result.current.userIds.size).toBe(0)
		expect(result.current.emails.size).toBe(0)
	})

	it("derives the blocked sets from cached data", () => {
		holder.data = { contacts: [], blocked: [blockedEntry(10n, "a@x.com")] }

		const { result } = renderHook(() => useBlockedUsers())

		expect(result.current.userIds.has(10n)).toBe(true)
		expect(result.current.emails.has("a@x.com")).toBe(true)
	})

	it("re-renders on a contacts cache event and ignores other keys", () => {
		holder.data = { contacts: [], blocked: [blockedEntry(10n, "a@x.com")] }

		const { result } = renderHook(() => useBlockedUsers())
		const first = result.current

		holder.data = { contacts: [], blocked: [blockedEntry(20n, "b@x.com")] }
		emit(["useChatsQuery"])

		expect(result.current).toBe(first)

		emit(["useContactsQuery"])

		expect(result.current.userIds.has(20n)).toBe(true)
		expect(result.current.userIds.has(10n)).toBe(false)
		expect(result.current.emails.has("b@x.com")).toBe(true)
	})

	it("returns the same value while the blocked array is unchanged", () => {
		const blocked = [blockedEntry(10n, "a@x.com")]

		holder.data = { contacts: [], blocked }

		const { result } = renderHook(() => useBlockedUsers())
		const first = result.current

		holder.data = { contacts: [blockedEntry(30n, "c@x.com")], blocked }
		emit(["useContactsQuery"])

		expect(result.current).toBe(first)
	})

	it("falls back to empty sets when the cached data is removed", () => {
		holder.data = { contacts: [], blocked: [blockedEntry(10n, "a@x.com")] }

		const { result } = renderHook(() => useBlockedUsers())

		holder.data = undefined
		emit(["useContactsQuery"])

		expect(result.current.userIds.size).toBe(0)
	})

	it("attaches one cache subscription for many consumers and detaches after the last unmounts", () => {
		const a = renderHook(() => useBlockedUsers())
		const b = renderHook(() => useBlockedUsers())

		expect(cache.attachCount).toBe(1)

		a.unmount()

		expect(cache.detachCount).toBe(0)

		b.unmount()

		expect(cache.detachCount).toBe(1)
	})
})
