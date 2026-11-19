import { describe, expect, it } from "vitest"
import { cfbBytes } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { DocError, docText, readDoc, type DocModel, type DocTable } from "@filen/office/core/doc"
import { buildDoc, lists, plc, prl, stsh, type DocSpec } from "./docFixtures"
import { encryptedDoc } from "./docDecryptFixtures"

async function read(spec: DocSpec): Promise<DocModel> {
	return readDoc(bytesSource(await buildDoc(spec)))
}

async function refusal(bytes: Uint8Array): Promise<DocError> {
	try {
		await readDoc(bytesSource(bytes))
	} catch (error) {
		if (error instanceof DocError) return error

		throw error
	}

	throw new Error("the file was read")
}

describe("Word binary text", () => {
	it("reads compressed text with the cp1252 substitutions of FcCompressed", async () => {
		const model = await read({ pieces: [{ text: "\u0093quoted\u0094 \u0080\r" }] })

		expect(model.text).toBe("“quoted” \u0080\r")
		expect(docText(model)).toBe("“quoted” \u0080\n")
	})

	it("joins compressed and UTF-16 pieces of a fast-saved file in CP order", async () => {
		const model = await read({
			pieces: [{ text: "Hello " }, { text: "мир ", compressed: false }, { text: "again\r" }],
			paragraphs: [{ end: 16 }]
		})

		expect(model.text).toBe("Hello мир again\r")
		expect(model.paragraphs).toHaveLength(1)
		expect(model.runs.map(run => [run.start, run.end])).toEqual([
			[0, 6],
			[6, 10],
			[10, 16]
		])
	})

	it("applies a piece's Prm0 and Prm1 property modifiers", async () => {
		// Prm0 isprm 0x55 = sprmCFBold, val 1; Prm1 igrpprl 0 = sprmCFItalic on.
		const model = await read({
			pieces: [
				{ text: "bold ", prm: (0x55 << 1) | (1 << 8) },
				{ text: "italic\r", prm: 1 }
			],
			prcs: [prl.toggle(0x0836, 1)]
		})

		expect(model.runs[0]?.props.bold).toBe(true)
		expect(model.runs[1]?.props.italic).toBe(true)
		expect(model.runs[1]?.props.bold).toBe(false)
	})

	it("reports text that lies outside the WordDocument stream instead of dropping it", async () => {
		const model = await read({ pieces: [{ text: "abc" }, { text: "def\r", fc: 0x3fff0000 }] })

		expect(model.text).toBe("abc\ufffd\ufffd\ufffd\ufffd")
		expect(model.issues.map(issue => issue.code)).toEqual(["damagedText"])
	})
})

describe("Word binary properties", () => {
	it("resolves ToggleOperand 0x81 against the style's value", async () => {
		const model = await read({
			pieces: [{ text: "plain flipped\r" }],
			structures: { stshf: stsh([{ name: "Normal", stk: 1, chpx: prl.toggle(0x0835, 1) }]) },
			runs: [
				{ start: 0, end: 6, grpprl: [] },
				{ start: 6, end: 14, grpprl: prl.toggle(0x0835, 0x81) }
			]
		})

		expect(model.runs[0]?.props.bold).toBe(true)
		expect(model.runs[1]?.props.bold).toBe(false)
	})

	it("inherits paragraph properties through istdBase and applies direct ones last", async () => {
		const model = await read({
			pieces: [{ text: "one\rtwo\r" }],
			structures: {
				stshf: stsh([
					{ name: "Normal", stk: 1, papx: prl.u16(0xa414, 200) },
					{ name: "Heading", stk: 1, base: 0, papx: prl.u8(0x2461, 1) }
				])
			},
			paragraphs: [
				{ end: 4, istd: 1 },
				{ end: 8, istd: 1, grpprl: prl.u8(0x2461, 2) }
			]
		})

		expect(model.paragraphs.map(paragraph => [paragraph.props.istd, paragraph.props.jc, paragraph.props.after])).toEqual([
			[1, 1, 200],
			[1, 2, 200]
		])
	})

	it("keeps unknown and untyped sprms in the direct grpprl and counts them", async () => {
		// sprmCRsidText (typed nowhere) and an undefined sprm with a 2-byte operand.
		const model = await read({
			pieces: [{ text: "x\r" }],
			runs: [{ start: 0, end: 2, grpprl: [...prl.u32(0x6816, 7), ...prl.u16(0x4aff, 9)] }]
		})

		expect(model.runs[0]?.direct).toEqual(Uint8Array.from([...prl.u32(0x6816, 7), ...prl.u16(0x4aff, 9)]))
		expect(model.untypedSprms.get("sprmCRsidText")).toBe(1)
		expect(model.untypedSprms.get("sprm0x4aff")).toBe(1)
	})
})

describe("Word binary structures", () => {
	it("nests cell and row marks into a table", async () => {
		const inTable = prl.u8(0x2416, 1)
		const model = await read({
			pieces: [{ text: "a\u0007b\u0007\u0007after\r" }],
			paragraphs: [
				{ end: 2, grpprl: inTable },
				{ end: 4, grpprl: inTable },
				{ end: 5, grpprl: [...inTable, ...prl.u8(0x2417, 1)] },
				{ end: 11 }
			]
		})
		const blocks = model.blocks.get("main") ?? []
		const table = blocks[0] as DocTable

		expect(table.kind).toBe("table")
		expect(table.rows).toHaveLength(1)
		expect(table.rows[0]?.cells.map(cell => cell.length)).toEqual([1, 1])
		expect(blocks[1]).toEqual({ kind: "paragraph", index: 3 })
		expect(docText(model)).toBe("a\nb\nafter\n")
	})

	it("shows field results and never field instructions", async () => {
		const text = 'see \u0013 PAGE \u00142\u0015 and \u0013 XE "x" \u0015.\r'
		const marks = [4, 11, 13, 19, 28]
		const model = await read({
			pieces: [{ text }],
			runs: [
				{ start: 0, end: 4, grpprl: [] },
				{ start: 4, end: 5, grpprl: prl.toggle(0x0855, 1) },
				{ start: 5, end: 11, grpprl: [] },
				{ start: 11, end: 12, grpprl: prl.toggle(0x0855, 1) },
				{ start: 12, end: 13, grpprl: [] },
				{ start: 13, end: 14, grpprl: prl.toggle(0x0855, 1) },
				{ start: 14, end: 19, grpprl: [] },
				{ start: 19, end: 20, grpprl: prl.toggle(0x0855, 1) },
				{ start: 20, end: 28, grpprl: [] },
				{ start: 28, end: 29, grpprl: prl.toggle(0x0855, 1) },
				{ start: 29, end: text.length, grpprl: [] }
			],
			// The PLC lists the PAGE field only: the XE field is found from its marks.
			structures: {
				plcfFldMom: plc(
					[marks[0] ?? 0, marks[1] ?? 0, marks[2] ?? 0, text.length],
					[
						[0x13, 33],
						[0x14, 0xff],
						[0x15, 0x80]
					]
				)
			}
		})

		expect(model.fields).toEqual([{ begin: 4, separator: 11, end: 13, type: 33, flags: 0x80, story: "main" }])
		expect(docText(model)).toBe("see 2 and .\n")
	})

	it("numbers list paragraphs with their level text", async () => {
		const { plfLst, lstLength, plfLfo } = lists([
			{ nfc: 0, text: "\u0000." },
			{ nfc: 4, text: "\u0000.\u0001)" }
		])
		const list = (level: number): number[] => [...prl.u16(0x460b, 1), ...prl.u8(0x260a, level)]
		const model = await read({
			pieces: [{ text: "a\rb\rc\rd\r" }],
			structures: { plfLst, plfLfo },
			lengths: { plfLst: lstLength },
			paragraphs: [
				{ end: 2, grpprl: list(0) },
				{ end: 4, grpprl: list(1) },
				{ end: 6, grpprl: list(1) },
				{ end: 8, grpprl: list(0) }
			]
		})

		expect(model.paragraphs.map(paragraph => paragraph.list?.text)).toEqual(["1.", "1.a)", "1.b)", "2."])
		expect(docText(model)).toBe("1. a\n1.a) b\n1.b) c\n2. d\n")
	})

	it("bounds hostile list start values and keeps small labels", async () => {
		const labels = async (start: number, nfc: number, count = 2): Promise<(string | undefined)[]> => {
			const { plfLst, lstLength, plfLfo } = lists([{ nfc, text: "\u0000.", start }])

			const model = await read({
				pieces: [{ text: "a\r".repeat(count) }],
				structures: { plfLst, plfLfo },
				lengths: { plfLst: lstLength },
				paragraphs: Array.from({ length: count }, (_, k) => ({
					end: 2 * (k + 1),
					grpprl: [...prl.u16(0x460b, 1), ...prl.u8(0x260a, 0)]
				}))
			})

			return model.paragraphs.map(paragraph => paragraph.list?.text)
		}

		// Word caps start values at 32767 and stops counting there; roman and letters fall back to decimal.
		expect(await labels(0x7fffffff, 2)).toEqual(["32767.", "32767."])
		expect(await labels(0x7fffffff, 4)).toEqual(["32767.", "32767."])
		expect(await labels(3999, 1)).toEqual(["MMMCMXCIX.", "4000."])
		expect(await labels(26 * 30, 4)).toEqual([`${"z".repeat(30)}.`, "781."])
		expect(await labels(-5, 4)).toEqual([".", "a."])
		expect(await labels(-5, 2)).toEqual([".", "i."])
		expect(await labels(1, 5, 3)).toEqual(["1st.", "2nd.", "3rd."])
		expect(await labels(4, 3)).toEqual(["D.", "E."])
		expect(await labels(9, 0x16)).toEqual(["09.", "10."])
		expect(await labels(1, 0xff)).toEqual([".", "."])
	})

	it("labels auto-numbered footnote references", async () => {
		const model = await read({
			pieces: [{ text: "Note\u0002 here\r\u0002 text\r\r" }],
			ccp: { text: 11, ftn: 7 },
			runs: [
				{ start: 0, end: 4, grpprl: [] },
				{ start: 4, end: 5, grpprl: prl.toggle(0x0855, 1) },
				{ start: 5, end: 18, grpprl: [] }
			],
			paragraphs: [{ end: 11 }, { end: 18 }],
			structures: { plcffndRef: plc([4, 11], [[1, 0]]), plcffndTxt: plc([0, 7, 8]) }
		})

		expect(model.footnotes).toEqual([{ reference: 4, auto: true, label: "1", text: { kind: "footnotes", start: 11, end: 18 } }])
		expect(docText(model)).toBe("Note1 here\n")
		expect(docText(model, { story: "footnotes" })).toBe(" text\n")
	})

	it("keeps an inline picture as a typed placeholder", async () => {
		const model = await read({
			pieces: [{ text: "a\u0001b\r" }],
			runs: [
				{ start: 0, end: 1, grpprl: [] },
				{ start: 1, end: 2, grpprl: [...prl.toggle(0x0855, 1), ...prl.u32(0x6a03, 0x1234)] },
				{ start: 2, end: 4, grpprl: [] }
			]
		})

		expect(model.placeholders).toEqual([{ kind: "picture", cp: 1, dataOffset: 0x1234 }])
		expect(docText(model)).toBe("ab\n")
	})
})

describe("Word binary refusals", () => {
	it("refuses a file that is not a compound file", async () => {
		expect((await refusal(new TextEncoder().encode("{\\rtf1 }"))).code).toBe("notWordBinary")
	})

	it("refuses a compound file without a WordDocument stream", async () => {
		expect((await refusal(await cfbBytes([{ path: ["Workbook"], bytes: new Uint8Array(16) }]))).code).toBe("notWordBinary")
	})

	it("refuses Word 6 and Word 95 files with their nFib", async () => {
		const error = await refusal(await buildDoc({ pieces: [{ text: "old\r" }], nFib: 0x65, wIdent: 0xa5dc }))

		expect([error.code, error.nFib]).toEqual(["legacyVersion", 0x65])
	})

	it("names the encryption scheme of an encrypted file", async () => {
		const flags = 0x0200 | 0x0100
		const rc4 = await refusal(await buildDoc({ pieces: [{ text: "x\r" }], flags, tablePrefix: Uint8Array.of(1, 0, 1, 0) }))
		// RC4 CryptoAPI is told by its EncryptionHeader too (a header too damaged to read is refused as corrupt).
		const cryptoApi = await refusal(
			(await encryptedDoc({ pieces: [{ text: "x\r" }] }, { scheme: "cryptoApiRc4", password: "pw" })).bytes
		)
		const damaged = await refusal(await buildDoc({ pieces: [{ text: "x\r" }], flags, tablePrefix: Uint8Array.of(2, 0, 2, 0) }))
		const xor = await refusal(await buildDoc({ pieces: [{ text: "x\r" }], flags: flags | 0x8000 }))

		expect([rc4, cryptoApi, xor, damaged].map(error => [error.code, error.encryption])).toEqual([
			["encrypted", "rc4"],
			["encrypted", "cryptoApiRc4"],
			["encrypted", "xor"],
			["corrupt", undefined]
		])
	})

	it("refuses a file whose Table stream is missing", async () => {
		expect((await refusal(await buildDoc({ pieces: [{ text: "x\r" }], noTable: true }))).code).toBe("corrupt")
	})
})
