import { vi, describe, it, expect, beforeEach } from "vitest"

// Everything below the query layer is stubbed, but @tanstack/react-query and the persister core are
// deliberately REAL here: this suite exists to prove removeQueryEverywhere actually matches and
// deletes, which a mocked QueryClient cannot show. src/tests/client.test.ts mocks both packages, so
// its coverage stops exactly where this one starts.
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")

	return {
		...actual,
		AppState: {
			...actual.AppState,
			currentState: "active"
		}
	}
})

// @filen/utils is deliberately REAL: sortParams is what shapes the query key this suite is pinning,
// so a stub would make the assertions circular.
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))
vi.mock("@/lib/utils", () => ({}))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// The persister's clear() reaches removeByPrefix, which the shared kv mock doesn't carry — the
// in-memory buffer is what this suite asserts on, so the SQLite side just needs to not throw.
vi.mock("@/lib/sqlite", () => ({
	default: {
		openDb: vi.fn(async () => ({ executeBatch: vi.fn(async () => undefined) })),
		kvAsync: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			removeByPrefix: vi.fn(async () => undefined)
		}
	}
}))

vi.mock("@/lib/sdkErrors", () => ({
	isNetworkClassError: () => false,
	unwrapSdkError: () => null
}))

vi.mock("@/lib/auth", () => ({
	default: { logout: vi.fn(async () => undefined) }
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn(), normal: vi.fn() }
}))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: { Unauthenticated: "Unauthenticated" }
}))

vi.mock("@/stores/useApp.store", () => ({
	default: { getState: () => ({ biometricUnlocked: true }) }
}))

import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core"
import queryClient, {
	persistedQueryStorageKey,
	removeQueryEverywhere,
	queryClientPersisterKv,
	QUERY_CLIENT_PERSISTER_PREFIX
} from "@/queries/client"
import { noteContentQueryKey } from "@/features/notes/queries/useNoteContent.query"

beforeEach(() => {
	queryClient.clear()
	queryClientPersisterKv.clear()
})

describe("removeQueryEverywhere", () => {
	// The eviction path behind "remove this note from offline". A silent no-op here would look like
	// the feature works while reclaiming nothing.
	it("removes a query written under a sortParams-shaped key", () => {
		const queryKey = noteContentQueryKey({ uuid: "note-a" })

		queryClient.setQueryData(queryKey, "body")

		expect(queryClient.getQueryData(queryKey)).toBe("body")

		removeQueryEverywhere(queryKey)

		expect(queryClient.getQueryData(queryKey)).toBeUndefined()
	})

	it("leaves other notes' bodies untouched", () => {
		const a = noteContentQueryKey({ uuid: "note-a" })
		const b = noteContentQueryKey({ uuid: "note-b" })

		queryClient.setQueryData(a, "a body")
		queryClient.setQueryData(b, "b body")

		removeQueryEverywhere(a)

		expect(queryClient.getQueryData(a)).toBeUndefined()
		expect(queryClient.getQueryData(b)).toBe("b body")
	})

	it("also drops the persisted row, not just the in-memory copy", () => {
		const queryKey = noteContentQueryKey({ uuid: "note-a" })
		const storageKey = persistedQueryStorageKey(queryKey)

		queryClientPersisterKv.setItem(storageKey, { some: "persisted row" })

		expect(queryClientPersisterKv.getItem(storageKey)).not.toBeNull()

		queryClient.setQueryData(queryKey, "body")
		removeQueryEverywhere(queryKey)

		expect(queryClientPersisterKv.getItem(storageKey)).toBeNull()
	})

	it("is a no-op for a key that was never cached", () => {
		expect(() => removeQueryEverywhere(noteContentQueryKey({ uuid: "never-seen" }))).not.toThrow()
	})
})

describe("persistedQueryStorageKey", () => {
	// Version-pinned third-party surface: createPersister builds `${prefix}-${queryHash}` internally.
	// If an upgrade changes that shape, our key stops addressing the row the persister wrote and
	// evictions silently stop reclaiming anything — so pin it against the REAL implementation rather
	// than against a copy of the format string.
	it("matches the key createPersister actually writes", async () => {
		const written = new Map<string, unknown>()

		const persister = experimental_createQueryPersister({
			storage: {
				getItem: (key: string) => written.get(key) ?? null,
				setItem: (key: string, value: unknown) => {
					written.set(key, value)
				},
				removeItem: (key: string) => {
					written.delete(key)
				}
			},
			prefix: QUERY_CLIENT_PERSISTER_PREFIX,
			serialize: query => query,
			deserialize: query => query as never
		})

		const queryKey = noteContentQueryKey({ uuid: "note-a" })

		queryClient.setQueryData(queryKey, "body")

		await persister.persistQueryByKey(queryKey, queryClient)

		expect([...written.keys()]).toEqual([persistedQueryStorageKey(queryKey)])
	})
})
