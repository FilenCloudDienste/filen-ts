import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { decodeUtf8 } from "@filen/office/core/xml"
import { readDoc } from "../core/doc/read"
import { convertDocToDocx } from "../core/doc/toDocx/index"
import { buildDoc, plc, type DocSpec } from "./docFixtures"

// Comment dates live in AtrdExtra (FibRgFcLcb2002): ATRDPost10s parallel to the ATRDPre10s in PlcfandRef.

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function utf16(text: string): number[] {
	return [...text].flatMap(char => u16(char.charCodeAt(0)))
}

// ATRDPre10: xstUsrInitl (cch + 9 UTF-16 units), ibst, bitsNotUsed, grfNotUsed, ITagBkmk.
function atrd(initials: string, ibst: number): number[] {
	const units = utf16(initials)

	return [
		...u16(initials.length),
		...units,
		...new Array<number>(18 - units.length).fill(0),
		...u16(ibst),
		0,
		0,
		0,
		0,
		...u32(0xffffffff)
	]
}

// ATRDPost10: dttm, padding1, cDepth, diatrdParent, discussItem.
function atrdPost10(dttm: number): number[] {
	return [...u32(dttm), 0, 0, ...u32(0), ...u32(0), ...u32(0)]
}

function xst(text: string): number[] {
	return [...u16(text.length), ...utf16(text)]
}

// 2024-03-15 13:45.
const DTTM = 45 | (13 << 6) | (15 << 11) | (3 << 16) | (124 << 20)

function spec(extra: readonly number[] | undefined): DocSpec {
	// Main "One\u0005Two\u0005\r", comments "\u0005A\r\u0005B\r", then the final paragraph mark.
	return {
		pieces: [{ text: "One\u0005Two\u0005\r\u0005A\r\u0005B\r\r" }],
		ccp: { text: 9, atn: 6 },
		structures: {
			plcfandRef: plc([3, 7, 9], [atrd("AB", 0), atrd("CD", 1)]),
			plcfandTxt: plc([0, 3, 6]),
			grpXstAtnOwners: new Uint8Array([...xst("Ann"), ...xst("Bob")]),
			...(extra === undefined ? {} : { atrdExtra: new Uint8Array(extra) })
		}
	}
}

describe("Word binary comment dates", () => {
	it("reads each comment's ATRDPost10.dttm and leaves zero dates unset", async () => {
		const model = await readDoc(bytesSource(await buildDoc(spec([...atrdPost10(DTTM), ...atrdPost10(0)]))))

		expect(model.comments.map(comment => [comment.author, comment.initials, comment.date])).toEqual([
			["Ann", "AB", "2024-03-15T13:45:00"],
			["Bob", "CD", undefined]
		])
	})

	it("leaves dates unset without AtrdExtra or past a short one", async () => {
		const none = await readDoc(bytesSource(await buildDoc(spec(undefined))))
		const short = await readDoc(bytesSource(await buildDoc(spec(atrdPost10(DTTM)))))

		expect(none.comments.map(comment => comment.date)).toEqual([undefined, undefined])
		expect(short.comments.map(comment => comment.date)).toEqual(["2024-03-15T13:45:00", undefined])
	})

	it("writes w:comment/@w:date only for dated comments", async () => {
		const result = await convertDocToDocx(bytesSource(await buildDoc(spec([...atrdPost10(DTTM), ...atrdPost10(0)]))))
		const bytes = result.parts.get("word/comments.xml")

		expect(bytes).toBeDefined()

		const xml = decodeUtf8(bytes ?? new Uint8Array())
		const comments = xml.match(/<w:comment [^>]*>/g) ?? []

		expect(comments).toHaveLength(2)
		expect(comments[0]).toContain('w:date="2024-03-15T13:45:00Z"')
		expect(comments[1]).not.toContain("w:date")
	})
})
