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

	it("places accented letters at their base letter, case-insensitively", () => {
		expect(compareNames("Äpfel", "apfel")).toBeGreaterThan(0)
		expect(compareNames("äpfel", "Äpfel")).toBe(0)
		expect(compareNames("Äpfel", "apple")).toBeLessThan(0)
		expect(compareNames("x é2", "x é10")).toBeLessThan(0)
		expect(compareNames("日本 2", "日本 10")).toBeLessThan(0)
		expect(compareNames("zebra", "Äpfel")).toBeGreaterThan(0)
	})

	it("orders a mixed set of names transitively, whatever the input order", () => {
		const names = [
			"zeta",
			"~temp",
			"übung",
			"{a",
			"|a",
			"}a",
			"Éb",
			"_a",
			"a1",
			"a10",
			"~$Bericht.docx",
			"Ärger.docx",
			"日本",
			"日本 2",
			"9z",
			"-a",
			"e{",
			"ez",
			"éa",
			"resume~x",
			"resumez",
			"résuméa",
			"cafe-menu.pdf",
			"cafe_menu.pdf",
			"café_menu.pdf",
			"ch",
			"ci",
			"cí",
			"cs",
			"cz",
			"cž",
			"ΑΣz",
			"ΑΣ~",
			"ασa",
			"ΑΣé"
		]

		for (const a of names) {
			for (const b of names) {
				for (const c of names) {
					if (compareNames(a, b) < 0 && compareNames(b, c) < 0) {
						expect([a, b, c, compareNames(a, c) < 0]).toEqual([a, b, c, true])
					}
				}
			}
		}

		const expected = [...names].sort(compareNames)
		const next = random(7)

		for (let round = 0; round < 50; round++) {
			const shuffled = [...names]

			for (let i = shuffled.length - 1; i > 0; i--) {
				const k = Math.floor(next() * (i + 1))
				const swap = shuffled[i] ?? ""

				shuffled[i] = shuffled[k] ?? ""
				shuffled[k] = swap
			}

			expect(shuffled.sort(compareNames)).toEqual(expected)
		}
	})

	it("sorts { | } ~ after letters, ASCII or not", () => {
		expect(compareNames("zeta", "~temp")).toBeLessThan(0)
		expect(compareNames("übung", "~temp")).toBeLessThan(0)
		expect(compareNames("Ärger.docx", "~$Bericht.docx")).toBeLessThan(0)
	})

	it("orders names sharing a prefix up to an accented letter in one order, whatever the input order", () => {
		const triples = [
			["e{", "ez", "éa"],
			["resume~x", "resumez", "résuméa"],
			["cafe-menu.pdf", "cafe_menu.pdf", "café_menu.pdf"],
			["ch", "ci", "cí"],
			["cs", "cz", "cž"],
			["ΑΣz", "ΑΣ~", "ασa"],
			["ΑΣz", "ΑΣ~", "ΑΣé"]
		]

		for (const [a = "", b = "", c = ""] of triples) {
			const expected = [a, b, c].sort(compareNames)

			for (const permutation of [
				[a, c, b],
				[b, a, c],
				[b, c, a],
				[c, a, b],
				[c, b, a]
			]) {
				expect(permutation.sort(compareNames)).toEqual(expected)
			}
		}

		expect(["e{", "ez", "éa"].sort(compareNames)).toEqual(["éa", "ez", "e{"])
		expect(["café_menu.pdf", "cafe_menu.pdf", "cafe-menu.pdf"].sort(compareNames)).toEqual([
			"cafe-menu.pdf",
			"cafe_menu.pdf",
			"café_menu.pdf"
		])
	})
})
