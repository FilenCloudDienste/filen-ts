import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The page's detector: loaded once on the first legacy file, asked only for bytes that are not Unicode, dropped on
// sign-out and after a failed load (the language's codepage stands in then).

const { asked } = vi.hoisted(() => ({ asked: [] as { bytes: Uint8Array; last: boolean }[] }))

vi.mock("@filen/encoding-detect", () => ({
	EncodingDetector: {
		instantiate: () =>
			Promise.resolve({
				guess: (bytes: Uint8Array, last: boolean) => {
					asked.push({ bytes, last })

					return "windows-1251"
				}
			})
	}
}))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn() } }))

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
})
