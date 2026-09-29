import { describe, expect, it, vi } from "vitest"
import { createListenerSet } from "@/lib/listenerSet"
import { withoutKey } from "@/lib/utils"

vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

describe("createListenerSet", () => {
	it("fans out past a throwing listener and stops after unsubscribe or clear", () => {
		const set = createListenerSet<number>("test")
		const seen: number[] = []

		set.subscribe(() => {
			throw new Error("boom")
		})

		const unsubscribe = set.subscribe(value => {
			seen.push(value)
		})

		set.emit(1)
		unsubscribe()
		set.emit(2)

		expect(seen).toEqual([1])

		set.subscribe(value => {
			seen.push(value)
		})
		set.clear()
		set.emit(3)

		expect(seen).toEqual([1])
	})
})

describe("withoutKey", () => {
	it("drops the key into a copy, and returns the same record when the key is absent", () => {
		const record = { a: 1, b: 2 }

		expect(withoutKey(record, "a")).toEqual({ b: 2 })
		expect(record).toEqual({ a: 1, b: 2 })
		expect(withoutKey(record, "c")).toBe(record)
		expect(withoutKey(record, "toString")).toBe(record)
	})
})
