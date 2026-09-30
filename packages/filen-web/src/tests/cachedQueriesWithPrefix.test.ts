import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient } from "@/queries/client"
import { cachedQueriesWithPrefix } from "@/queries/patch"

const PREFIX = ["drive", "listing"] as const
const OTHER = ["photos", "listing"] as const

function seed(key: readonly unknown[]): void {
	queryClient.setQueryData(key, [])
}

// The reference the mirror must reproduce: members and order.
function scanned(prefix: readonly [string, string]): unknown[] {
	return queryClient.getQueryCache().findAll({ queryKey: prefix })
}

beforeEach(() => {
	queryClient.clear()
})

describe("cachedQueriesWithPrefix", () => {
	it("seeds from the cache and matches findAll in members and order", () => {
		seed([...PREFIX, { variant: "drive", uuid: "a" }])
		seed(["drive", "dirSize", "a"])
		seed([...OTHER, "root"])
		seed([...PREFIX, { variant: "drive", uuid: "b" }])
		seed(["drive"])

		expect(cachedQueriesWithPrefix(PREFIX)).toEqual(scanned(PREFIX))
		expect(cachedQueriesWithPrefix(PREFIX)).toHaveLength(2)
		expect(cachedQueriesWithPrefix(OTHER)).toEqual(scanned(OTHER))
	})

	it("follows adds and removes after seeding", () => {
		seed([...PREFIX, { variant: "drive", uuid: "a" }])
		cachedQueriesWithPrefix(PREFIX)
		cachedQueriesWithPrefix(OTHER)

		seed([...PREFIX, { variant: "drive", uuid: "b" }])
		seed([...OTHER, "root"])
		seed(["drive", "dirSize", "b"])
		expect(cachedQueriesWithPrefix(PREFIX)).toEqual(scanned(PREFIX))
		expect(cachedQueriesWithPrefix(OTHER)).toEqual(scanned(OTHER))

		queryClient.removeQueries({ queryKey: [...PREFIX, { variant: "drive", uuid: "a" }], exact: true })
		expect(cachedQueriesWithPrefix(PREFIX)).toEqual(scanned(PREFIX))
		expect(cachedQueriesWithPrefix(PREFIX)).toHaveLength(1)
	})

	it("moves a removed and re-added key to the end, as the cache does", () => {
		const a = [...PREFIX, { variant: "drive", uuid: "a" }]
		seed(a)
		seed([...PREFIX, { variant: "drive", uuid: "b" }])
		cachedQueriesWithPrefix(PREFIX)

		queryClient.removeQueries({ queryKey: a, exact: true })
		seed(a)

		const mirrored = cachedQueriesWithPrefix(PREFIX)

		expect(mirrored).toEqual(scanned(PREFIX))
		expect(mirrored.map(query => query.queryKey)).toEqual([[...PREFIX, { variant: "drive", uuid: "b" }], a])
	})

	it("empties on clear and refills after", () => {
		seed([...PREFIX, { variant: "drive", uuid: "a" }])
		cachedQueriesWithPrefix(PREFIX)

		queryClient.clear()
		expect(cachedQueriesWithPrefix(PREFIX)).toEqual([])

		seed([...PREFIX, { variant: "drive", uuid: "c" }])
		expect(cachedQueriesWithPrefix(PREFIX)).toEqual(scanned(PREFIX))
	})

	it("returns a fresh array each call, safe to patch while iterating", () => {
		seed([...PREFIX, { variant: "drive", uuid: "a" }])

		const first = cachedQueriesWithPrefix(PREFIX)

		for (const query of first) {
			queryClient.removeQueries({ queryKey: query.queryKey, exact: true })
			seed([...PREFIX, { variant: "drive", uuid: "z" }])
		}

		expect(first).toHaveLength(1)
		expect(cachedQueriesWithPrefix(PREFIX)).not.toBe(first)
		expect(cachedQueriesWithPrefix(PREFIX)).toEqual(scanned(PREFIX))
	})

	it("keeps the active filter equal to findAll's", () => {
		seed([...PREFIX, { variant: "drive", uuid: "a" }])
		seed([...PREFIX, { variant: "drive", uuid: "b" }])

		const observer = new QueryObserver(queryClient, {
			queryKey: [...PREFIX, { variant: "drive", uuid: "b" }],
			queryFn: () => Promise.resolve([]),
			staleTime: Infinity
		})
		const unsubscribe = observer.subscribe(() => undefined)

		expect(cachedQueriesWithPrefix(PREFIX).filter(query => query.isActive())).toEqual(
			queryClient.getQueryCache().findAll({ queryKey: PREFIX, type: "active" })
		)
		expect(cachedQueriesWithPrefix(PREFIX).filter(query => query.isActive())).toHaveLength(1)
		unsubscribe()
	})
})
