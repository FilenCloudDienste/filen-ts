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

describe("EncodingDetector", () => {
	it("guesses Cyrillic and Japanese", () => {
		expect(detector.guess(CP1251, true)).toBe("windows-1251")
		expect(detector.guess(SHIFT_JIS, true)).toBe("shift_jis")
	})

	it("takes a prefix cut inside a character", () => {
		expect(detector.guess(SHIFT_JIS.subarray(0, SHIFT_JIS.length - 1), false)).toBe("shift_jis")
	})

	it("reads only the first GUESS_BYTES of a large file, then again a small one", () => {
		const large = new Uint8Array(GUESS_BYTES + 4096)

		for (let i = 0; i < large.length; i += CP1251.length) {
			large.set(CP1251.subarray(0, Math.min(CP1251.length, large.length - i)), i)
		}

		expect(detector.guess(large, true)).toBe("windows-1251")
		expect(detector.guess(SHIFT_JIS, true)).toBe("shift_jis")
	})
})
