import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The page's detector: loaded once on the first legacy file, asked only for bytes that are not Unicode, dropped on
// sign-out and after a failed load (the language's codepage stands in then).

const { asked, answer, disposers } = vi.hoisted(() => ({
	asked: [] as { bytes: Uint8Array; last: boolean }[],
	answer: { current: "windows-1251" },
	// The sign-out registry: what is registered and not yet unregistered.
	disposers: new Set<() => void>()
}))

vi.mock("@filen/encoding-detect", () => ({
	EncodingDetector: {
		instantiate: () =>
			Promise.resolve({
				guess: (bytes: Uint8Array, last: boolean) => {
					asked.push({ bytes, last })

					return answer.current
				}
			})
	}
}))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn() } }))
vi.mock("@/lib/workers/previewDisposers", () => ({
	registerPreviewDisposer: (_label: string, dispose: () => void) => {
		disposers.add(dispose)

		return () => {
			disposers.delete(dispose)
		}
	},
	runPreviewDisposers: () => {
		const pending = [...disposers]

		disposers.clear()
		pending.forEach(dispose => {
			dispose()
		})
	}
}))

const { guessLegacyEncoding, readTextFileDetected } = await import("@/features/preview/lib/encodingGuess")
const { runPreviewDisposers } = await import("@/lib/workers/previewDisposers")

let compiled = 0
let failNext = false

beforeEach(() => {
	vi.stubGlobal("fetch", () => Promise.resolve(new Response()))
	vi.stubGlobal("WebAssembly", {
		...WebAssembly,
		compileStreaming: () => {
			compiled++

			if (failNext) {
				failNext = false

				return Promise.reject(new Error("offline"))
			}

			return Promise.resolve({})
		}
	})
})

afterEach(() => {
	runPreviewDisposers()
	compiled = 0
	asked.length = 0
})

const CYRILLIC = Uint8Array.of(0xcf, 0xf0, 0xe8)

describe("the encoding detector on the page", () => {
	it("reads bytes that are not Unicode with its guess, loading it once", async () => {
		expect(await readTextFileDetected(CYRILLIC)).toMatchObject({ text: "При", encoding: "windows-1251" })
		expect(await guessLegacyEncoding(CYRILLIC, true)).toBe("windows-1251")
		expect(compiled).toBe(1)
		expect(asked).toEqual([
			{ bytes: CYRILLIC, last: true },
			{ bytes: CYRILLIC, last: true }
		])
	})

	it("never asks about Unicode", async () => {
		expect(await readTextFileDetected(new TextEncoder().encode("plain"))).toMatchObject({ encoding: "utf-8" })
		expect(compiled).toBe(0)
	})

	it("loads again after sign-out and after a failed load, keeping the language's codepage meanwhile", async () => {
		await guessLegacyEncoding(CYRILLIC, true)
		runPreviewDisposers()
		failNext = true

		expect(await readTextFileDetected(CYRILLIC)).toMatchObject({ encoding: "windows-1252" })
		expect(await guessLegacyEncoding(CYRILLIC, true)).toBe("windows-1251")
		expect(compiled).toBe(3)
	})

	it("keeps no sign-out entry for a load that failed", async () => {
		failNext = true

		expect(await guessLegacyEncoding(CYRILLIC, true)).toBeNull()
		expect(disposers.size).toBe(0)
		expect(await guessLegacyEncoding(CYRILLIC, true)).toBe("windows-1251")
		expect(disposers.size).toBe(1)
	})

	it("answers with the menu's label for the detector's name", async () => {
		answer.current = "gbk"

		expect(await guessLegacyEncoding(Uint8Array.of(0xc4, 0xe3), true)).toBe("gb18030")
		answer.current = "windows-1251"
	})

	// Not Unicode: the strict UTF-8 attempt, then the codepage's decode, once each.
	it("decodes a legacy file once", async () => {
		const decode = vi.spyOn(TextDecoder.prototype, "decode")

		await readTextFileDetected(CYRILLIC)

		expect(decode).toHaveBeenCalledTimes(2)
	})

	it("reads a legacy file in the codepage it is known to be in, without the detector", async () => {
		expect(await readTextFileDetected(CYRILLIC, "koi8-r")).toMatchObject({ encoding: "koi8-r" })
		expect(asked).toEqual([])
		expect(compiled).toBe(0)
	})
})
