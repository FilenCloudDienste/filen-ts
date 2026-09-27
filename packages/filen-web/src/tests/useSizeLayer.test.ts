// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

// The file entry's read is held until the test releases it, so changes can land before the load does.
const { kvStore, held } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	held: { release: (): void => undefined, gate: null as Promise<void> | null }
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: async (key: string) => {
		if (key.startsWith("spreadsheet.sizes.v1.") && held.gate !== null) {
			await held.gate
		}

		return kvStore.get(key) ?? null
	},
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

import { useSizeLayer } from "@/features/spreadsheet/hooks/useSizeLayer"

const KEY = { kind: "stable", id: "f1" } as const

function stored(): unknown {
	return kvStore.get("spreadsheet.sizes.v1.f1")
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	kvStore.clear()
	held.gate = null
})

describe("useSizeLayer", () => {
	it("keeps both of two changes made before a re-render", async () => {
		const { result } = renderHook(() => useSizeLayer(KEY))

		await settle()

		act(() => {
			result.current.update(0, "cols", [[1, 80]])
			result.current.update(0, "cols", [[2, 90]])
		})
		await settle()

		expect([...(result.current.layer.get(0)?.cols ?? [])]).toEqual([
			[1, 80],
			[2, 90]
		])
		expect(stored()).toEqual({
			sheets: {
				"0": {
					cols: [
						[1, 80],
						[2, 90]
					],
					rows: []
				}
			}
		})
	})

	it("keeps the stored sizes when a change lands before they load", async () => {
		kvStore.set("spreadsheet.sizes.v1.f1", { sheets: { "0": { cols: [[0, 50]], rows: [] } } })
		held.gate = new Promise(resolve => {
			held.release = resolve
		})

		const { result } = renderHook(() => useSizeLayer(KEY))

		act(() => {
			result.current.update(0, "cols", [[3, 70]])
		})

		// Nothing is written over the stored entry before it has been read.
		expect(stored()).toEqual({ sheets: { "0": { cols: [[0, 50]], rows: [] } } })

		held.release()
		await settle()

		expect(stored()).toEqual({
			sheets: {
				"0": {
					cols: [
						[0, 50],
						[3, 70]
					],
					rows: []
				}
			}
		})
	})

	it("honours a reset made before the stored sizes load", async () => {
		kvStore.set("spreadsheet.sizes.v1.f1", { sheets: { "0": { cols: [[0, 50]], rows: [] } } })
		held.gate = new Promise(resolve => {
			held.release = resolve
		})

		const { result } = renderHook(() => useSizeLayer(KEY))

		act(() => {
			result.current.update(0, "cols", [[0, null]])
		})
		held.release()
		await settle()

		expect(result.current.layer.get(0)).toBeUndefined()
		expect(stored()).toBeUndefined()
	})
})
