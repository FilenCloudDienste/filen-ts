import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { BOXED, LINES } from "../core/odp/write/emit/box"
import { concatBytes, indexOfBytes, isXmlNameEnd } from "../core/xml/bytes"
import { encodeUtf8 } from "../core/xml/index"

// The byte helpers the XML scanners share, and the element tables the ODP writer keeps in one place.

describe("the shared XML byte helpers", () => {
	it("joins chunks in order, empty ones included", () => {
		expect([...concatBytes([])]).toEqual([])
		expect([...concatBytes([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])])]).toEqual([1, 2, 3])
	})

	it('ends a qualified name at whitespace, ">", "/" and the end of the bytes only', () => {
		const tag = encodeUtf8("<a:b\tc/>")

		for (const byte of [0x20, 0x09, 0x0a, 0x0d, 0x3e, 0x2f, undefined]) expect(isXmlNameEnd(byte)).toBe(true)
		for (const byte of [0x3a, 0x2d, 0x2e, 0x5f, 0x61, 0x0c, 0xef]) expect(isXmlNameEnd(byte)).toBe(false)

		let end = 1

		while (!isXmlNameEnd(tag[end])) end++

		expect(end).toBe(4)
	})

	it("finds a byte sequence at or after a place, past a partial match", () => {
		const bytes = encodeUtf8("-- --> -->")

		expect(indexOfBytes(bytes, encodeUtf8("-->"), 0)).toBe(3)
		expect(indexOfBytes(bytes, encodeUtf8("-->"), 4)).toBe(7)
		expect(indexOfBytes(bytes, encodeUtf8("-->"), 8)).toBe(-1)
		expect(indexOfBytes(bytes, encodeUtf8("?>"), 0)).toBe(-1)
	})
})

describe("the ODP writer's element tables", () => {
	it("are defined once, in emit/box.ts, and read by the proof gate, the slide resize and the shape emitter", () => {
		expect(BOXED.has("draw:custom-shape")).toBe(true)
		expect(BOXED.has("dr3d:scene")).toBe(true)
		expect(BOXED.has("draw:g")).toBe(false)
		expect([...LINES].sort()).toEqual(["draw:connector", "draw:line", "draw:measure"])

		for (const [module, from] of [
			["../core/odp/write/proof.ts", "./emit/box"],
			["../core/odp/write/emit/design.ts", "./box"],
			["../core/odp/write/emit/shape.ts", "./box"]
		] as const) {
			const source = readFileSync(fileURLToPath(new URL(module, import.meta.url)), "utf8")

			expect(source).toMatch(new RegExp(`import \\{[^}]*\\bBOXED\\b[^}]*\\bLINES\\b[^}]*\\} from "${from}"`, "u"))
			expect(source).not.toMatch(/draw:regular-polygon/u)
		}
	})
})
