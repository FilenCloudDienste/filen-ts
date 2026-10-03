import { beforeEach, describe, expect, it, vi } from "vitest"
import { readSignedInHint, writeSignedInHint } from "@/lib/signedInHint"

const store = new Map<string, string>()

beforeEach(() => {
	store.clear()
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value)
		},
		removeItem: (key: string) => {
			store.delete(key)
		}
	})
})

describe("signed-in hint", () => {
	it("round-trips a boolean and stores nothing when signed out", () => {
		expect(readSignedInHint()).toBe(false)

		writeSignedInHint(true)
		expect(readSignedInHint()).toBe(true)
		expect([...store.values()]).toEqual(["1"])

		writeSignedInHint(false)
		expect(readSignedInHint()).toBe(false)
		expect(store.size).toBe(0)
	})

	it("reads as signed out and never throws when storage is blocked", () => {
		const blocked = (): never => {
			throw new DOMException("denied", "SecurityError")
		}

		vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked })

		expect(readSignedInHint()).toBe(false)
		expect(() => {
			writeSignedInHint(true)
			writeSignedInHint(false)
		}).not.toThrow()
	})
})
