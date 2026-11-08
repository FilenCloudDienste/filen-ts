import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LockId, UuidStr } from "@filen/sdk-rs"
import {
	forgetPersistedOwedLocks,
	installOwedLocksHandoff,
	onLockEvent,
	owedLocks,
	OWED_LOCKS_KEY,
	persistOwedLocks,
	releaseInheritedOwedLocks,
	takeInheritedOwedLocks
} from "@/lib/sdk/owedLocks"

// The page's mirror of the locks its client owes, handed to the next page through sessionStorage on pagehide.
const store = new Map<string, string>()
const setItem = vi.fn((key: string, value: string) => store.set(key, value))
const removeItem = vi.fn((key: string) => store.delete(key))

function lock(n: number): LockId {
	return { uuid: `0000000${String(n)}-0000-4000-8000-000000000000` as UuidStr, resource: `r${String(n)}` }
}

function settleAll(): void {
	for (const held of [...owedLocks().values()]) {
		onLockEvent({ kind: "settled", lock: held })
	}
}

beforeEach(() => {
	store.clear()
	vi.stubGlobal("sessionStorage", { getItem: (key: string) => store.get(key) ?? null, setItem, removeItem })
	setItem.mockClear()
	removeItem.mockClear()
})

afterEach(() => {
	settleAll()
	vi.useRealTimers()
})

describe("lock mirror", () => {
	it("adds a lock on owed and drops it on settled", () => {
		onLockEvent({ kind: "owed", lock: lock(1) })
		onLockEvent({ kind: "owed", lock: lock(2) })
		onLockEvent({ kind: "settled", lock: lock(1) })

		expect([...owedLocks().values()]).toEqual([lock(2)])
	})
})

describe("pagehide", () => {
	it("writes the owed locks when the page is not kept in the bfcache", () => {
		onLockEvent({ kind: "owed", lock: lock(1) })

		persistOwedLocks({ persisted: false })

		expect(JSON.parse(store.get(OWED_LOCKS_KEY) ?? "null")).toEqual([lock(1)])
	})

	it("writes nothing for a page kept in the bfcache", () => {
		onLockEvent({ kind: "owed", lock: lock(1) })

		persistOwedLocks({ persisted: true })

		expect(setItem).not.toHaveBeenCalled()
		expect(removeItem).not.toHaveBeenCalled()
	})

	it("only removes the key when nothing is owed", () => {
		store.set(OWED_LOCKS_KEY, "[]")

		persistOwedLocks({ persisted: false })

		expect(setItem).not.toHaveBeenCalled()
		expect(store.has(OWED_LOCKS_KEY)).toBe(false)
	})

	it("removes the key when a bfcache page is shown again, and only then", () => {
		store.set(OWED_LOCKS_KEY, "[]")

		forgetPersistedOwedLocks({ persisted: false })
		expect(store.has(OWED_LOCKS_KEY)).toBe(true)

		forgetPersistedOwedLocks({ persisted: true })
		expect(store.has(OWED_LOCKS_KEY)).toBe(false)
	})

	it("listens on pagehide and pageshow", () => {
		const addEventListener = vi.fn()

		installOwedLocksHandoff({ addEventListener })

		expect(addEventListener).toHaveBeenCalledWith("pagehide", persistOwedLocks)
		expect(addEventListener).toHaveBeenCalledWith("pageshow", forgetPersistedOwedLocks)
	})
})

describe("inherited locks", () => {
	it("consumes the key at once and adds its locks to the mirror", () => {
		store.set(OWED_LOCKS_KEY, JSON.stringify([lock(1), lock(2)]))

		expect(takeInheritedOwedLocks()).toEqual([lock(1), lock(2)])
		expect(store.has(OWED_LOCKS_KEY)).toBe(false)
		// A tab duplicated after this copies nothing.
		expect(takeInheritedOwedLocks()).toEqual([])
		// A reload during the release hands them on again.
		persistOwedLocks({ persisted: false })
		expect(JSON.parse(store.get(OWED_LOCKS_KEY) ?? "null")).toEqual([lock(1), lock(2)])
	})

	it("leaves out a lock this client reported itself", () => {
		onLockEvent({ kind: "owed", lock: lock(1) })
		store.set(OWED_LOCKS_KEY, JSON.stringify([lock(1), lock(2)]))

		expect(takeInheritedOwedLocks()).toEqual([lock(2)])
	})

	it("drops an invalid or unparseable value", () => {
		store.set(OWED_LOCKS_KEY, JSON.stringify([{ uuid: "not-a-uuid", resource: "r" }, { uuid: 1 }]))
		expect(takeInheritedOwedLocks()).toEqual([])
		expect(store.has(OWED_LOCKS_KEY)).toBe(false)

		store.set(OWED_LOCKS_KEY, "{")
		expect(takeInheritedOwedLocks()).toEqual([])
	})

	it("does not call the release with nothing inherited", async () => {
		const release = vi.fn(() => Promise.resolve())

		await releaseInheritedOwedLocks([], release)

		expect(release).not.toHaveBeenCalled()
	})

	it("clears released locks from the mirror", async () => {
		store.set(OWED_LOCKS_KEY, JSON.stringify([lock(1)]))
		const inherited = takeInheritedOwedLocks()

		await releaseInheritedOwedLocks(inherited, () => Promise.resolve())

		expect(owedLocks().size).toBe(0)
	})

	it("continues on a timeout and keeps the locks owed", async () => {
		vi.useFakeTimers()
		store.set(OWED_LOCKS_KEY, JSON.stringify([lock(1)]))
		const inherited = takeInheritedOwedLocks()
		const release = vi.fn(() => new Promise<void>(() => undefined))

		const released = releaseInheritedOwedLocks(inherited, release, 3_000)
		await vi.advanceTimersByTimeAsync(3_000)
		await released

		expect(release).toHaveBeenCalledWith([lock(1)])
		expect([...owedLocks().values()]).toEqual([lock(1)])
	})
})
