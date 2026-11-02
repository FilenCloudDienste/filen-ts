import { describe, expect, it } from "vitest"
import { inScope } from "../core/anim/prune"
import { transformCalls } from "../core/odp/read/shapes"
import { withoutManifestEntries } from "../core/odp/write/manifestPrune"
import { transformNames } from "../core/odp/write/proof"
import { declared } from "../core/odp/write/styles"
import { withoutTrailingDigits } from "../core/pptx/write/parts"
import { motionPathSyntax } from "../core/presentation/edit/apply/motionPathSyntax"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { partsNamed } from "../dom/presentation/detailParts"
import { budget, cpuMs } from "./timing"

// Scans of markup and values from the file that read as an expression with a leading or nested repeat reads, in time
// linear in what they read: each against its expression (kept here as its definition) on random short inputs, and
// on hostile ones of a megabyte within a budget.

const MEGABYTE = 1_000_000

// A small deterministic generator: the same inputs every run.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0

		return state / 2 ** 32
	}
}

function samples(alphabet: readonly string[], count: number, longest: number, seed: number): string[] {
	const next = random(seed)
	const out: string[] = []

	for (let k = 0; k < count; k++) {
		let text = ""
		const length = Math.floor(next() * (longest + 1))

		for (let at = 0; at < length; at++) text += alphabet[Math.floor(next() * alphabet.length)] ?? ""

		out.push(text)
	}

	return out
}

function within(ms: number, run: () => unknown): number {
	const start = cpuMs()

	run()

	const spent = cpuMs() - start

	expect(spent).toBeLessThanOrEqual(budget(ms))

	return spent
}

describe("draw:transform", () => {
	const DEFINITION = /([a-zA-Z]+)\s*\(([^)]*)\)/gu
	const NAMES = /([a-zA-Z]+)\s*\(/gu

	it("reads its calls and names as the expressions do", () => {
		for (const text of samples(["a", "b", "rotate", "(", ")", " ", "1", ",", "x("], 20_000, 10, 1)) {
			expect(transformCalls(text).map(call => [call.name, call.args])).toEqual(
				[...text.matchAll(DEFINITION)].map(match => [match[1], match[2]])
			)
			expect(transformNames(text)).toEqual([...text.matchAll(NAMES)].map(match => (match[1] ?? "").toLowerCase()))
		}
	})

	it("reads a megabyte of letters, or of unclosed calls, in time linear in it", () => {
		within(100, () => transformCalls("a".repeat(MEGABYTE)))
		within(100, () => transformCalls("a(".repeat(MEGABYTE / 2)))
		within(100, () => transformNames("a".repeat(MEGABYTE)))
	})
})

describe("held timing markup put back in scope", () => {
	it("takes declarations in scope off its start tag, and reads a megabyte of whitespace in time linear in it", () => {
		const scope = new Map([["p", "urn:p"]])

		expect(decodeUtf8(inScope(encodeUtf8('<p:par  xmlns:p="urn:p" xmlns:q="urn:q"><x/></p:par>'), scope))).toBe(
			'<p:par xmlns:q="urn:q"><x/></p:par>'
		)
		within(100, () => inScope(encodeUtf8(`<p:par${" ".repeat(MEGABYTE)}a="b"/>`), scope))
	})
})

describe("new style markup's declarations", () => {
	it("reads attributes, not names inside their values, in time linear in a megabyte value", () => {
		expect(declared('<style:style style:name="a" text:x="draw:y=1"/>', new Map())).toContain('xmlns:text="')
		expect(declared('<style:style style:name="a" text:x="draw:y=1"/>', new Map())).not.toContain("xmlns:draw")
		within(100, () => declared(`<style:style style:name="${"a".repeat(MEGABYTE)}"/>`, new Map()))
	})
})

describe("a motion path's syntax", () => {
	const DEFINITION = /^[\s,]*(?:(?:[MLCZEmlcze]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[\s,]*)+$/u

	it("is the expression's language", () => {
		for (const text of samples(["M", "L", "e", "E", "z", "1", "2", ".", "+", "-", " ", ",", "\t", "x"], 100_000, 12, 2))
			expect([text, motionPathSyntax(text)]).toEqual([text, DEFINITION.test(text)])
	})

	it("decides a megabyte path in time linear in it", () => {
		within(150, () => expect(motionPathSyntax(`M${"1".repeat(MEGABYTE)}x`)).toBe(false))
		within(150, () => expect(motionPathSyntax(`M ${"1.5e2 ".repeat(MEGABYTE / 6)}`)).toBe(true))
	})
})

describe("part names in a refusal's detail", () => {
	const DEFINITION = /[\w.-]+(?:\/[\w.-]+)*\.(?:xml|rels)(?:#[\w.-]+|\b)/gu

	it("are the expression's matches", () => {
		for (const text of samples(["a", ".", "/", "-", "#", " ", "_", ".xml", ".rels", "x", "s", "1", "//", "é"], 100_000, 10, 3)) {
			const names = text.match(DEFINITION)

			expect([text, partsNamed(text)]).toEqual([
				text,
				names === null ? undefined : new Set(names.map(name => (name.startsWith("/") ? name : `/${name}`)))
			])
		}
	})

	it("are found in time linear in a megabyte detail", () => {
		within(100, () => partsNamed("a/".repeat(MEGABYTE / 2)))
		within(100, () => partsNamed("a".repeat(MEGABYTE)))
	})
})

describe("manifest entries a save leaves out", () => {
	const DEFINITION = /[ \t]*<([\w.-]+:)?file-entry\b[^>]*?(?:\/>|>[\s\S]*?<\/\1?file-entry>)(?:[ \t]*\r?\n)?/gu

	function expected(text: string, names: readonly string[]): string {
		const gone = new Set(names)

		return text.replace(DEFINITION, entry => {
			const path = /\bfull-path\s*=\s*"([^"]*)"/u.exec(entry)?.[1]

			return path !== undefined && gone.has(path) ? "" : entry
		})
	}

	it("go as the expression takes them", () => {
		const parts = [
			" ",
			"\t",
			"\n",
			"\r\n",
			'<m:file-entry m:full-path="a"/>',
			'<file-entry full-path="b">',
			"</file-entry>",
			"</m:file-entry>",
			'<m:file-entry m:full-path="a">x',
			"<x/>",
			">",
			'<file-entry full-path="a"',
			"/>"
		]

		for (const text of samples(parts, 50_000, 8, 4)) {
			const written = decodeUtf8(withoutManifestEntries(encodeUtf8(text), ["a", "b"]))

			expect([text, written]).toEqual([text, expected(text, ["a", "b"])])
		}
	})

	it("go in time linear in a manifest of a megabyte of indent or of unclosed entries", () => {
		within(100, () => withoutManifestEntries(encodeUtf8(`${" ".repeat(MEGABYTE)}x`), ["a"]))
		within(150, () => withoutManifestEntries(encodeUtf8('<file-entry full-path="a">'.repeat(MEGABYTE / 26)), ["a"]))
	})
})

describe("a part name's stem without its number", () => {
	it("takes the trailing digits off, in time linear in the stem", () => {
		expect(withoutTrailingDigits("slide12")).toBe("slide")
		expect(withoutTrailingDigits("a1b2")).toBe("a1b")
		expect(withoutTrailingDigits("123")).toBe("")
		expect(withoutTrailingDigits("")).toBe("")
		within(50, () => withoutTrailingDigits(`${"1".repeat(MEGABYTE)}x`))
	})
})
