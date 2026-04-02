/**
 * Shared mock of @/lib/sqlite for Vitest.
 *
 * Provides an in-memory Map-backed kvAsync (get/set/remove).
 *
 * Usage in test files:
 *
 *   const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))
 *   vi.mock("@/lib/sqlite", async () => (await import("@/tests/mocks/sqliteKv")).createSqliteKvMock(kvStore))
 */

import { vi } from "vitest"

export function createSqliteKvMock(kvStore: Map<string, unknown>) {
	return {
		default: {
			kvAsync: {
				get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
				set: vi.fn(async (key: string, value: unknown) => {
					kvStore.set(key, value)
				}),
				remove: vi.fn(async (key: string) => {
					kvStore.delete(key)
				})
			}
		}
	}
}
