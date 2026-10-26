import { afterEach, describe, expect, it, vi } from "vitest"
import { fontFaceHost, LOCAL_FONT_TIMEOUT_MS, type FontFaceScope } from "../dom/fontFaceHost"

// An installed-font lookup that never answers (Firefox's workers drop a FontFace only its own pending load refers
// to, and that load then never settles) must not hold up the text waiting on it.

function scopeWith(load: () => Promise<unknown>): { scope: FontFaceScope; added: unknown[] } {
	const added: unknown[] = []
	const scope: FontFaceScope = {
		FontFace: class {
			load(): Promise<unknown> {
				return load()
			}
		},
		fonts: { add: face => added.push(face), delete: () => true }
	}

	return { scope, added }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("fontFaceHost loads", () => {
	it("answers false for an installed font whose lookup never settles, once the bound passes", async () => {
		vi.useFakeTimers()

		const { scope, added } = scopeWith(() => new Promise(() => undefined))
		const host = fontFaceHost(scope)
		let answer: boolean | undefined

		void host.addLocal({ family: "fo1-l1", weight: 400, italic: false }, "Wingdings 2").then(value => {
			answer = value
		})
		await vi.advanceTimersByTimeAsync(LOCAL_FONT_TIMEOUT_MS - 1)
		expect(answer).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1)
		expect(answer).toBe(false)
		expect(added).toEqual([])
	})

	it("answers a lookup that settles in time without waiting for the bound", async () => {
		vi.useFakeTimers()

		const { scope, added } = scopeWith(() => Promise.resolve(undefined))
		const host = fontFaceHost(scope)

		await expect(host.addLocal({ family: "fo1-l2", weight: 400, italic: false }, "Aptos")).resolves.toBe(true)
		expect(added).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("never bounds a face loaded from bytes", async () => {
		vi.useFakeTimers()

		let finish: () => void = () => undefined
		const { scope } = scopeWith(
			() =>
				new Promise(resolve => {
					finish = () => resolve(undefined)
				})
		)
		const host = fontFaceHost(scope)
		const loading = host.addBytes({ family: "fo1-b", weight: 400, italic: false }, new Uint8Array(4))

		await vi.advanceTimersByTimeAsync(LOCAL_FONT_TIMEOUT_MS * 4)
		finish()
		await expect(loading).resolves.toBe(true)
	})
})
