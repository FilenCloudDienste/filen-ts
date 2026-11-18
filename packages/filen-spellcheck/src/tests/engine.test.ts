import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import { SpellEngine, type SpellDictionary } from "../engine"
import { DICTIONARY_IDS } from "../languages"
import { MANIFEST_URL, NGRAM_AFF, NGRAM_DIC, TINY_AFF, TINY_DIC, dictionariesBuilt, readDictionary, wasmBytes } from "./fixtures"

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe("SpellEngine", () => {
	let engine: SpellEngine
	let tiny: SpellDictionary

	beforeAll(async () => {
		engine = await SpellEngine.instantiate(wasmBytes())

		const loaded = engine.load(encode(TINY_AFF), encode(TINY_DIC))

		if (loaded === undefined) throw new Error("the fixture does not parse")

		tiny = loaded
	})

	it("checks words in batches", () => {
		expect([...tiny.check(["hello", "helo", "worlds", "café", "Hello", "HELLO", "cafe"])]).toEqual([1, 0, 1, 1, 1, 1, 0])
		expect(tiny.check([])).toEqual(new Uint8Array(0))
	})

	it("handles non-ASCII and long input without corrupting memory", () => {
		const words = Array.from({ length: 5000 }, (_, i) => (i % 2 === 0 ? "café" : `wörd${String(i)}`))
		const verdicts = tiny.check(words)

		expect([...verdicts]).toEqual(words.map((_, i) => (i % 2 === 0 ? 1 : 0)))
		expect([...tiny.check(["hello"])]).toEqual([1])
	})

	it("refuses a word list whose count does not match", () => {
		expect(() => tiny.check(["a\nb"])).toThrow(/rejected a word list/)
	})

	it("suggests corrections, fast pass and n-gram pass", () => {
		expect(tiny.suggest("helo", false)[0]).toBe("hello")
		expect(tiny.suggest("fone", false)).toContain("phone")
		expect(tiny.suggest("x\ny", false)).toEqual([])
	})

	it("runs the n-gram pass only when asked", () => {
		const dictionary = engine.load(encode(NGRAM_AFF), encode(NGRAM_DIC))

		expect(dictionary?.suggest("spelign", false)).toEqual([])
		expect(dictionary?.suggest("spelign", true)).toContain("spelling")
		dictionary?.dispose()
	})

	it("adds words with Hunspell's casing", () => {
		expect([...tiny.check(["filen"])]).toEqual([0])
		expect(tiny.add("filen")).toBe(true)
		expect([...tiny.check(["filen", "Filen", "FILEN"])]).toEqual([1, 1, 1])
		expect(tiny.add("A/S")).toBe(true)
		expect([...tiny.check(["A/S"])]).toEqual([1])
	})

	// The raw exports with arbitrary ids, lengths and scratch contents: every call answers a number, none
	// traps, and every address the module hands out lies inside its memory.
	it("survives arbitrary arguments at the boundary", async () => {
		const instance = await WebAssembly.instantiate(new WebAssembly.Module(wasmBytes()), {})
		const x = instance.exports as unknown as Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory }
		const aff = encode(TINY_AFF)
		const dic = encode(TINY_DIC)
		let state = 0x9e3779b9

		const next = (): number => {
			state ^= state << 13
			state ^= state >>> 17
			state ^= state << 5

			return state >>> 0
		}
		const inMemory = (ptr: number, len: number): boolean => ptr > 0 && ptr + len <= x.memory.buffer.byteLength
		const region = (len: number): Uint8Array => {
			const ptr = x["fs_buffer"]?.(len) ?? 0

			expect(inMemory(ptr, len)).toBe(true)

			return new Uint8Array(x.memory.buffer, ptr, len)
		}
		const scratch = region(aff.byteLength + dic.byteLength)

		scratch.set(aff)
		scratch.set(dic, aff.byteLength)

		const id = x["fs_new"]?.(aff.byteLength, dic.byteLength) ?? 0

		expect(id).toBeGreaterThan(0)

		const huge = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, -1]

		for (let round = 0; round < 20_000; round++) {
			const pick = next()
			const small = next() % 96
			const length = pick & 1 ? small : (huge[next() % huge.length] ?? 0)
			const someId = [0, id, id + 1, -1, next()][next() % 5] ?? 0
			let result: number

			switch ((pick >>> 1) % 8) {
				case 0: {
					const bytes = region(small)

					for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff

					continue
				}
				case 1:
					result = x["fs_check"]?.(someId, length) ?? 0

					if (result > 0) expect(inMemory(x["fs_output"]?.() ?? 0, result)).toBe(true)

					break
				case 2:
					result = x["fs_suggest"]?.(someId, Math.min(length, small), next() & 1) ?? 0

					if (result > 0) expect(inMemory(x["fs_output"]?.() ?? 0, result)).toBe(true)

					break
				case 3:
					result = x["fs_add"]?.(someId, length) ?? 0
					break
				case 4:
					result = x["fs_new"]?.(length, small) ?? 0

					if (result > 0) x["fs_drop"]?.(result)

					break
				case 5:
					result = x["fs_drop"]?.(someId === id ? 0 : someId) ?? 0
					break
				case 6:
					result = x["fs_buffer"]?.(length) ?? 0

					if (result !== 0) expect(inMemory(result, Math.min(length >>> 0, 2 ** 26))).toBe(true)

					break
				default:
					result = x["fs_output"]?.() ?? 0
			}

			expect(Number.isInteger(result)).toBe(true)
		}

		// The dictionary still answers after all of it.
		const words = encode("hello\nhelo")

		region(words.byteLength).set(words)
		expect(x["fs_check"]?.(id, words.byteLength)).toBe(2)
		expect([...new Uint8Array(x.memory.buffer, x["fs_output"]?.() ?? 0, 2)]).toEqual([1, 0])
	})

	it("embeds no machine paths (the module is reproducible)", () => {
		const bytes = Buffer.from(wasmBytes())

		for (const path of [fileURLToPath(new URL("../..", import.meta.url)), homedir(), "/Users/", "/home/"]) {
			expect(bytes.includes(path), path).toBe(false)
		}
	})

	it("rejects dictionaries that do not parse", () => {
		expect(engine.load(encode("FLAG num\n"), encode("1\nword/abc\n"))).toBeUndefined()
		expect(engine.load(new Uint8Array([0xff, 0xfe]), encode("0\n"))).toBeUndefined()
	})

	it("refuses a disposed dictionary", () => {
		const other = engine.load(encode(TINY_AFF), encode(TINY_DIC))

		other?.dispose()
		other?.dispose()
		expect(() => other?.check(["hello"])).toThrow(/disposed/)
	})
})

// Every shipped dictionary parses and agrees with Hunspell on a few words; prints load time and memory.
describe.skipIf(!dictionariesBuilt())("shipped dictionaries", () => {
	const cases: Record<string, { readonly good: readonly string[]; readonly bad: readonly string[]; readonly typo?: [string, string] }> = {
		en_US: { good: ["color", "don't", "optimize", "Washington"], bad: ["colour", "teh"], typo: ["recieve", "receive"] },
		en_GB: { good: ["colour", "optimise"], bad: ["color", "teh"], typo: ["recieve", "receive"] },
		en_CA: { good: ["colour", "realize"], bad: ["teh"] },
		en_AU: { good: ["colour", "realise"], bad: ["teh"] },
		de_DE: { good: ["Straße", "Donaudampfschifffahrt", "Häuser"], bad: ["Strase"], typo: ["Huas", "Haus"] },
		de_AT: { good: ["Straße", "Jänner"], bad: ["Strase"] },
		de_CH: { good: ["Strasse"], bad: ["Strase"] },
		fr: { good: ["été", "aujourd'hui", "naïve"], bad: ["etee"], typo: ["bonjoru", "bonjour"] },
		es_ES: { good: ["año", "corazón"], bad: ["corazon"] },
		it_IT: { good: ["perché", "città"], bad: ["cittá"] },
		pt_BR: { good: ["coração", "você"], bad: ["voce"] },
		pt_PT: { good: ["coração", "facto"], bad: ["fato1"] },
		nl_NL: { good: ["fiets", "huizen"], bad: ["fietz"] },
		pl_PL: { good: ["źdźbło", "książka"], bad: ["ksiazka"] },
		ru_RU: { good: ["привет", "дом"], bad: ["привед"] },
		sv_SE: { good: ["hus", "smörgås"], bad: ["smorgas"] },
		da_DK: { good: ["hus", "A/S", "rødgrød"], bad: ["huus"] },
		cs_CZ: { good: ["žluťoučký", "kůň"], bad: ["kůňě"] }
	}

	it("covers every dictionary id", () => {
		expect(Object.keys(cases).sort()).toEqual([...DICTIONARY_IDS].sort())
		expect(JSON.parse(readFileSync(MANIFEST_URL, "utf8")).dictionaries.map((d: { id: string }) => d.id)).toEqual([...DICTIONARY_IDS])
	})

	for (const id of DICTIONARY_IDS) {
		it(`${id} loads and checks`, async () => {
			const engine = await SpellEngine.instantiate(wasmBytes())
			const { aff, dic } = readDictionary(id)
			const before = engine.memoryBytes
			const start = performance.now()
			const dictionary = engine.load(aff, dic)
			const loadMs = performance.now() - start
			const spec = cases[id]

			expect(dictionary, `${id} parses`).toBeDefined()

			if (dictionary === undefined || spec === undefined) return

			expect([...dictionary.check(spec.good)], `${id} accepts ${spec.good.join(", ")}`).toEqual(spec.good.map(() => 1))
			expect([...dictionary.check(spec.bad)], `${id} rejects ${spec.bad.join(", ")}`).toEqual(spec.bad.map(() => 0))

			if (spec.typo !== undefined) expect(dictionary.suggest(spec.typo[0], false)).toContain(spec.typo[1])

			console.info(
				`${id}: load ${loadMs.toFixed(0)} ms, wasm memory +${((engine.memoryBytes - before) / 1048576).toFixed(1)} MiB (files ${((aff.byteLength + dic.byteLength) / 1048576).toFixed(1)} MiB)`
			)
		})
	}
})
