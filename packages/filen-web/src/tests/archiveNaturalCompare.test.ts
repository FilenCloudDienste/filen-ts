import { describe, expect, it } from "vitest"
import { comparePartsNumeric, getNameParts } from "@filen/shared"
import { compareNames } from "@/features/archive/lib/naturalCompare"

function shared(a: string, b: string): number {
	return Math.sign(comparePartsNumeric(getNameParts(a), getNameParts(b)))
}

// Deterministic, so a failure reproduces.
function random(seed: number): () => number {
	let state = seed

	return () => {
		state = (state * 1103515245 + 12345) % 2147483648

		return state / 2147483648
	}
}

const ALPHABET = "aAbBzZ0019 ._-~!()[]"

describe("compareNames", () => {
	it("orders like the shared naturalSort on hand-picked ASCII cases", () => {
		const cases: [string, string][] = [
			["file2", "file10"],
			["File1", "file1"],
			["a01", "a1"],
			["a01b", "a1"],
			["a1", "a01b"],
			["a", "a1"],
			["a!", "a1"],
			["ab", "a1"],
			["1a", "a"],
			["a", "_"],
			["A", "_"],
			["x9", "x09"],
			["", "a"],
			["img_0001.jpg", "IMG_1.JPG"],
			["v1.2.10", "v1.2.9"],
			["12345678901234567", "12345678901234568"],
			["123456789012345678901", "99999999999999"],
			["1".repeat(400), "1".repeat(401)],
			[`${"9".repeat(400)}a`, `${"9".repeat(400)}b`],
			["0000", "0"],
			["a0", "a00"]
		]

		for (const [a, b] of cases) {
			expect([a, b, compareNames(a, b)]).toEqual([a, b, shared(a, b)])
			expect([b, a, compareNames(b, a)]).toEqual([b, a, shared(b, a)])
		}
	})

	it("orders like the shared naturalSort on random ASCII names", () => {
		const next = random(42)
		const name = (): string =>
			Array.from({ length: Math.floor(next() * 9) }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("")

		for (let i = 0; i < 20000; i++) {
			const a = name()
			const b = next() < 0.3 ? a.toUpperCase() : name()

			expect(Math.sign(compareNames(a, b))).toBe(shared(a, b))
		}
	})

	it("hands non-ASCII differences to the collator, case-insensitively", () => {
		expect(compareNames("Äpfel", "apfel")).toBeGreaterThan(0)
		expect(compareNames("äpfel", "Äpfel")).toBe(0)
		expect(compareNames("Äpfel", "apple")).toBeLessThan(0)
		expect(compareNames("x é2", "x é10")).toBeLessThan(0)
		expect(compareNames("日本 2", "日本 10")).toBeLessThan(0)
		expect(compareNames("zebra", "Äpfel")).toBeGreaterThan(0)
	})
})
