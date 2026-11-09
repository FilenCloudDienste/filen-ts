import { describe, expect, it } from "vitest"

import { Bytes } from "../core/doc/bytes"
import { readFonts } from "../core/doc/fonts"

function ffn(name: string): number[] {
	const body = new Array<number>(39).fill(0)

	for (const char of name) body.push(char.charCodeAt(0), 0)

	body.push(0, 0)

	return [body.length, ...body]
}

function sttbfFfn(entries: number[][]): Bytes {
	const bytes = [entries.length, 0, 0, 0, ...entries.flat()]

	return new Bytes(Uint8Array.from(bytes), "table")
}

describe("readFonts", () => {
	it("keeps the slot of an FFN shorter than its header so later ftc indexes still resolve", () => {
		const short = [5, 1, 2, 3, 4, 5]
		const table = sttbfFfn([ffn("Arial"), short, ffn("Times New Roman")])
		const fonts = readFonts(table, 0, table.length)

		expect(fonts).toHaveLength(3)
		expect(fonts[0]?.name).toBe("Arial")
		expect(fonts[1]?.name).toBe("")
		expect(fonts[1]?.panose.length).toBe(0)
		expect(fonts[1]?.signature.length).toBe(0)
		expect(fonts[2]?.name).toBe("Times New Roman")
	})
})
