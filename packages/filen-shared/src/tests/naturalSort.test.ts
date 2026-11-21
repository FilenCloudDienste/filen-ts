import { describe, it, expect } from "vitest"
import {
	getUuidNumber,
	getNameParts,
	comparePartsNumeric,
	clearNaturalSortCaches,
	NATURAL_SORT_CACHE_CAP,
	compareNames,
	compareIds,
	compareNamesThenIds,
	compareTextRuns,
	fastLocaleCompare,
	sortItems,
	type SortEngineAccessors,
	type SortMode
} from "@filen/shared"

describe("getNameParts", () => {
	it("splits a name into alternating string/number runs", () => {
		expect(getNameParts("img10.png")).toEqual(["img", 10, ".png"])
	})

	it("parses a leading digit run", () => {
		expect(getNameParts("10img")).toEqual([10, "img"])
	})

	it("parses an absurdly long digit run the same way parseInt would", () => {
		expect(getNameParts("1".repeat(30))).toEqual([parseInt("1".repeat(30), 10)])
	})

	it("lowercases before parsing", () => {
		expect(getNameParts("IMG10.PNG")).toEqual(["img", 10, ".png"])
	})

	it("returns an empty array for an empty string", () => {
		expect(getNameParts("")).toEqual([])
	})

	it("memoizes: repeated calls for the same key return the SAME array reference", () => {
		const first = getNameParts("cache-me-10")
		const second = getNameParts("cache-me-10")

		expect(first).toBe(second)
	})
})

describe("comparePartsNumeric", () => {
	it("orders digit runs numerically, not lexically", () => {
		expect(comparePartsNumeric(getNameParts("img9"), getNameParts("img10"))).toBeLessThan(0)
	})

	it("orders string runs lexically", () => {
		expect(comparePartsNumeric(getNameParts("apple"), getNameParts("banana"))).toBeLessThan(0)
	})

	it("sorts a number part before a string part at the same position", () => {
		expect(comparePartsNumeric(["10"], [10]) === 0).toBe(false)
		expect(comparePartsNumeric([10], ["a"])).toBeLessThan(0)
		expect(comparePartsNumeric(["a"], [10])).toBeGreaterThan(0)
	})

	it("breaks ties by length when all shared parts are equal", () => {
		expect(comparePartsNumeric(["a"], ["a", "b"])).toBeLessThan(0)
		expect(comparePartsNumeric(["a", "b"], ["a"])).toBeGreaterThan(0)
	})

	it("short-circuits to 0 for the same cached parts array (reference equality)", () => {
		const parts = getNameParts("same-name")

		expect(comparePartsNumeric(parts, parts)).toBe(0)
	})

	it("returns 0 for keys that differ only by case", () => {
		expect(comparePartsNumeric(getNameParts("Case10"), getNameParts("cASE10"))).toBe(0)
	})

	it("returns 0 for equal, distinct arrays", () => {
		expect(comparePartsNumeric(["a", 1], ["a", 1])).toBe(0)
	})
})

describe("getUuidNumber", () => {
	it("extracts the numeric digits of a uuid", () => {
		expect(getUuidNumber("a1b2c3")).toBe(123)
	})

	it("memoizes per uuid", () => {
		expect(getUuidNumber("no-digits-here")).toBe(0)
		expect(getUuidNumber("no-digits-here")).toBe(0)
	})
})

describe("clearNaturalSortCaches", () => {
	it("evicts the name-parts cache so a later call returns a fresh array", () => {
		const before = getNameParts("evict-me-1")

		clearNaturalSortCaches()

		const after = getNameParts("evict-me-1")

		expect(after).not.toBe(before)
		expect(after).toEqual(before)
	})
})

describe("cache bound", () => {
	const sortNames = (names: string[]): string[] => names.slice().sort((a, b) => comparePartsNumeric(getNameParts(a), getNameParts(b)))

	it("clears the name-parts cache once it holds NATURAL_SORT_CACHE_CAP entries", () => {
		clearNaturalSortCaches()

		const first = getNameParts("bound-first")

		for (let i = 1; i < NATURAL_SORT_CACHE_CAP; i++) {
			getNameParts(`bound-${i}`)
		}

		// Exactly at the cap: nothing evicted yet
		expect(getNameParts("bound-first")).toBe(first)

		getNameParts("bound-overflow")

		const after = getNameParts("bound-first")

		expect(after).not.toBe(first)
		expect(after).toEqual(first)
	})

	it("sorts identically before and after an overflow clear", () => {
		clearNaturalSortCaches()

		const names = ["img10.png", "img2.png", "IMG1.png", "a", "b10", "b9", "img2.png"]
		const before = sortNames(names)

		for (let i = 0; i <= NATURAL_SORT_CACHE_CAP; i++) {
			getNameParts(`overflow-${i}`)
		}

		expect(sortNames(names)).toEqual(before)
	})

	it("keeps uuid numbers correct across an overflow clear", () => {
		clearNaturalSortCaches()

		const value = getUuidNumber("1a2b3c")

		for (let i = 0; i <= NATURAL_SORT_CACHE_CAP; i++) {
			getUuidNumber(`uuid-${i}`)
		}

		expect(getUuidNumber("1a2b3c")).toBe(value)
	})
})

interface NamedItem {
	uuid: string
	name: string
}

const namedAccessors: SortEngineAccessors<NamedItem> = {
	getUuid: item => item.uuid,
	getSize: () => 0n,
	isDirectory: () => false,
	nameKey: item => item.name
}

const nameAscending: SortMode<NamedItem> = {
	kind: "parts",
	isAsc: true,
	stringKey: item => item.name
}

function driveOrder(names: string[]): string[] {
	return sortItems(
		names.map((name, index) => ({ uuid: `uuid-${index}`, name })),
		nameAscending,
		namedAccessors
	).map(item => item.name)
}

const MIXED_NAMES = [
	"zeta",
	"~temp",
	"~$Bericht.docx",
	"übung",
	"{a",
	"|pipe",
	"}brace",
	"Éb",
	"éclair.txt",
	"Ärger.txt",
	"apple.txt",
	"Zebra.txt",
	"Émile",
	"Zoe",
	"_a",
	"a1",
	"a10",
	"file2",
	"file10",
	"日本 2",
	"日本 10",
	"Ωmega",
	"Яблоко",
	"x é2",
	"x é10",
	"-dash",
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
	"Ørsted",
	"Łódź",
	"ё",
	"е",
	"ж",
	"e\u0301clair",
	"éclair",
	"ΑΣz",
	"ΑΣ~",
	"ασa",
	"ΑΣé"
]

const PREFIX_TRIPLES = [
	["e{", "ez", "éa"],
	["resume~x", "resumez", "résuméa"],
	["cafe-menu.pdf", "cafe_menu.pdf", "café_menu.pdf"],
	["ch", "ci", "cí"],
	["cs", "cz", "cž"],
	["ΑΣz", "ΑΣ~", "ασa"],
	["ΑΣz", "ΑΣ~", "ΑΣé"]
]

function permutations(names: string[]): string[][] {
	if (names.length <= 1) {
		return [names]
	}

	return names.flatMap((name, index) => permutations([...names.slice(0, index), ...names.slice(index + 1)]).map(rest => [name, ...rest]))
}

describe("natural order across non-ASCII names", () => {
	it("is transitive over mixed ASCII punctuation, accented, Cyrillic and CJK names", () => {
		const comparators = [
			compareNames,
			fastLocaleCompare,
			(a: string, b: string) => comparePartsNumeric(getNameParts(a), getNameParts(b))
		]

		for (const compare of comparators) {
			for (const a of MIXED_NAMES) {
				for (const b of MIXED_NAMES) {
					expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0)

					for (const c of MIXED_NAMES) {
						if (compare(a, b) < 0 && compare(b, c) < 0) {
							expect([a, b, c, compare(a, c) < 0]).toEqual([a, b, c, true])
						}
					}
				}
			}
		}
	})

	it("gives the drive listing, fastLocaleCompare and compareNames the same order", () => {
		const expected = [...MIXED_NAMES].sort(compareNames)

		expect(driveOrder(MIXED_NAMES)).toEqual(expected)
		expect(driveOrder([...MIXED_NAMES].reverse())).toEqual(expected)
		expect([...MIXED_NAMES].reverse().sort(fastLocaleCompare)).toEqual(expected)
		expect([...MIXED_NAMES].reverse().sort(compareNames)).toEqual(expected)
	})

	it("orders accented and non-Latin names alphabetically, not by code unit", () => {
		expect(driveOrder(["Zebra.txt", "éclair.txt", "apple.txt", "Ärger.txt"])).toEqual([
			"apple.txt",
			"Ärger.txt",
			"éclair.txt",
			"Zebra.txt"
		])
		expect(["Zoe", "Émile"].sort(fastLocaleCompare)).toEqual(["Émile", "Zoe"])
		expect(["Zoe", "Émile"].sort(compareNames)).toEqual(["Émile", "Zoe"])
	})

	it("sorts { | } ~ after every letter, ASCII or not", () => {
		expect(compareNames("zeta", "~temp")).toBeLessThan(0)
		expect(compareNames("übung", "~temp")).toBeLessThan(0)
		expect(compareNames("übung", "zeta")).toBeLessThan(0)
		expect(compareTextRuns("{", "é")).toBe(1)
		expect(compareTextRuns("é", "~")).toBe(-1)
	})

	it("keeps ASCII text runs in code-unit order", () => {
		expect(compareTextRuns("-a", "_a")).toBe(-1)
		expect(compareTextRuns("ab", "abc")).toBe(-1)
		expect(compareTextRuns("abc", "abc")).toBe(0)
		expect(compareTextRuns("z", "~")).toBe(-1)
	})

	it("gives every permutation of names sharing a prefix up to an accented letter one order", () => {
		for (const triple of PREFIX_TRIPLES) {
			const expected = driveOrder(triple)

			for (const permutation of permutations(triple)) {
				expect(driveOrder(permutation)).toEqual(expected)
				expect([...permutation].sort(fastLocaleCompare)).toEqual(expected)
				expect([...permutation].sort(compareNames)).toEqual(expected)
			}
		}

		expect(driveOrder(["e{", "ez", "éa"])).toEqual(["éa", "ez", "e{"])
		expect(driveOrder(["café_menu.pdf", "cafe_menu.pdf", "cafe-menu.pdf"])).toEqual(["cafe-menu.pdf", "cafe_menu.pdf", "café_menu.pdf"])
		expect(driveOrder(["cí", "ci", "ch"])).toEqual(["ch", "ci", "cí"])
	})

	it("places letters at their base letter and the rest after ASCII by code unit", () => {
		expect(compareTextRuns("ørsted", "oz")).toBe(-1)
		expect(compareTextRuns("łódź", "lz")).toBe(-1)
		expect(compareTextRuns("ё", "ж")).toBe(-1)
		expect(compareTextRuns("е", "ё")).toBe(-1)
		expect(compareTextRuns("~", "日")).toBe(-1)
		expect(compareTextRuns("e\u0301clair", "éclair")).toBe(-1)
		expect(compareTextRuns("e\u0301clair", "eclair")).toBe(1)
		expect(compareTextRuns("e\u0301clair", "ed")).toBe(-1)
	})

	it("breaks fastLocaleCompare ties between case-only non-ASCII names, lowercase first", () => {
		expect(fastLocaleCompare("école", "École")).toBe(-1)
		expect(fastLocaleCompare("École", "école")).toBe(1)
		expect(fastLocaleCompare("Écolé", "ÉcolÉ")).toBe(-1)
		expect(fastLocaleCompare("École2", "école1")).toBe(1)
	})

	it("calls case-only non-ASCII differences equal", () => {
		expect(compareNames("äpfel", "Äpfel")).toBe(0)
		expect(comparePartsNumeric(getNameParts("ÄPFEL2"), getNameParts("äpfel2"))).toBe(0)
	})
})

describe("compareNamesThenIds", () => {
	it("breaks a natural, case-insensitive name tie on the id", () => {
		expect(compareNames("File 01", "file 1")).toBe(0)
		expect(compareNamesThenIds("File 01", "b", "file 1", "a")).toBe(1)
		expect(compareNamesThenIds("file 1", "a", "File 01", "b")).toBe(-1)
		expect(compareNamesThenIds("a 2", "z", "a 10", "a")).toBe(-1)
	})

	it("is 0 only for the same id", () => {
		expect(compareIds("x", "x")).toBe(0)
		expect(compareIds("x", "y")).toBe(-1)
		expect(compareIds("y", "x")).toBe(1)
	})
})
