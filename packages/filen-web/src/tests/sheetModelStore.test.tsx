// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { createModelStore } from "@/features/spreadsheet/lib/modelStore"

// The per-grid UI store: one value per grid, read by a hook, set from anywhere; `equal` decides what notifies.

function grid(): SheetGridModel {
	return {} as SheetGridModel
}

describe("a per-grid UI store", () => {
	it("holds one value per grid, starting from the initial one", () => {
		const store = createModelStore<string | null>(null)
		const first = grid()
		const second = grid()

		store.set(first, "open")

		expect(store.get(first)).toBe("open")
		expect(store.get(second)).toBeNull()
	})

	it("re-renders a reader when its grid's value changes, and not for an equal value or another grid", () => {
		const store = createModelStore(false)
		const first = grid()
		const second = grid()
		let renders = 0
		const { result } = renderHook(() => {
			renders++

			return store.useValue(first)
		})
		const before = renders

		act(() => {
			store.set(first, false)
			store.set(second, true)
		})

		expect(renders).toBe(before)

		act(() => {
			store.set(first, true)
		})

		expect(result.current).toBe(true)
		expect(renders).toBe(before + 1)
	})

	it("compares with the given equality: an equal value keeps the held one, a never-equal store notifies every set", () => {
		const same = createModelStore<{ key: number } | null>(null, (a, b) => a?.key === b?.key)
		const always = createModelStore<{ key: number } | null>(null, () => false)
		const model = grid()
		const held = { key: 1 }

		same.set(model, held)
		same.set(model, { key: 1 })

		expect(same.get(model)).toBe(held)

		let renders = 0
		const { result } = renderHook(() => {
			renders++

			return always.useValue(model)
		})
		const before = renders

		act(() => {
			always.set(model, held)
		})
		act(() => {
			always.set(model, held)
		})

		expect(result.current).toBe(held)
		expect(renders).toBe(before + 1)

		act(() => {
			always.set(model, { key: 1 })
		})

		expect(result.current).not.toBe(held)
		expect(renders).toBe(before + 2)
	})
})
