import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { WASM_PATH } from "../../scripts/build-wasm.mjs"
import { EncodingDetector, GUESS_BYTES } from "../index"

const detector = await EncodingDetector.instantiate(new Uint8Array(readFileSync(WASM_PATH)))

// Samples in their legacy encodings (bytes written out, so the tests need no encoder).
function hex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16))
}

// "Съешь же ещё этих мягких французских булок, да выпей чаю."
const CP1251 = hex("d1fae5f8fc20e6e520e5f9b820fdf2e8f520ecffe3eae8f520f4f0e0edf6f3e7f1eae8f520e1f3ebeeea2c20e4e020e2fbefe5e920f7e0fe2e")
// "いろはにほへと ちりぬるを わかよたれそ つねならむ"
const SHIFT_JIS = hex("82a282eb82cd82c982d982d682c62082bf82e882ca82e982f02082ed82a982e682bd82ea82bb2082c282cb82c882e782de")
// The same kana back to back: two-byte characters only, an even period.
const SHIFT_JIS_RUN = SHIFT_JIS.filter(byte => byte !== 0x20)

// One buffer past GUESS_BYTES for every large-file test, each filling what it reads.
const large = new Uint8Array(GUESS_BYTES + 4096 + CP1251.length)

function fill(target: Uint8Array, from: number, sample: Uint8Array): void {
	for (let i = from; i < target.length; i += sample.length) {
		target.set(sample.subarray(0, Math.min(sample.length, target.length - i)), i)
	}
}

describe("EncodingDetector", () => {
	it("guesses Cyrillic and Japanese", () => {
		expect(detector.guess(CP1251, true)).toBe("windows-1251")
		expect(detector.guess(SHIFT_JIS, true)).toBe("shift_jis")
	})

	it("takes a prefix cut inside a character", () => {
		expect(detector.guess(SHIFT_JIS.subarray(0, SHIFT_JIS.length - 1), false)).toBe("shift_jis")
	})

	it("reads only the first GUESS_BYTES of a large file, then again a small one", () => {
		const file = large.subarray(0, GUESS_BYTES + 4096)

		fill(file, 0, CP1251)

		expect(detector.guess(file, true)).toBe("windows-1251")
		expect(detector.guess(SHIFT_JIS, true)).toBe("shift_jis")
	})

	it("has no guess for ASCII, small or large", () => {
		const file = large.subarray(0, GUESS_BYTES + 4096)

		file.fill(0x20)

		expect(detector.guess(new TextEncoder().encode("plain ascii"), true)).toBeNull()
		expect(detector.guess(file, true)).toBeNull()
		expect(detector.guess(file, false)).toBeNull()
	})

	it("reads a large file from its first non-ASCII byte", () => {
		large.fill(0x20)
		large.set(CP1251, GUESS_BYTES + 4096)

		expect(detector.guess(large, true)).toBe("windows-1251")
	})

	// GUESS_BYTES is even and the characters start at index 1, so the window ends on a lead byte: it is a prefix, cut
	// inside a character, which must not count against Shift_JIS.
	it("feeds a large file's window as a prefix", () => {
		const file = large.subarray(0, GUESS_BYTES + 4096)

		file[0] = 0x20
		fill(file, 1, SHIFT_JIS_RUN)

		expect(SHIFT_JIS_RUN.length % 2).toBe(0)
		expect(detector.guess(file, true)).toBe("shift_jis")
	})
})
