import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { DocError } from "@filen/office/core/doc"
import { decodeUtf8, parseXml } from "@filen/office/core/xml"
import { convertDocToDocx, type DocConversionResult } from "../core/doc/toDocx/index"
import { legacyPasswordVerifier, readProtectionHash } from "../core/docx/protection/hash"
import { hashLegacyProtectionKey, verifyProtectionPassword } from "../dom/protection"
import { compatElements, settingsPart } from "../core/doc/toDocx/settings"
import { readDoc } from "../core/doc/read"
import { buildDoc, lists, plc, prl, stsh, type DocSpec } from "./docFixtures"
import { docxBodyText, reopen } from "./docToDocxFixtures"

// Word binary documents converted to WordprocessingML: what each structure becomes, and that the package reads
// back through the docx reader with the same text.

async function convert(spec: DocSpec): Promise<DocConversionResult> {
	return convertDocToDocx(bytesSource(await buildDoc(spec)))
}

function part(result: DocConversionResult, name: string): string {
	const bytes = result.parts.get(name)

	if (bytes === undefined) throw new Error(`no ${name}`)

	// Every part is well-formed XML.
	parseXml(bytes)

	return decodeUtf8(bytes)
}

describe("Word binary to WordprocessingML", () => {
	it("writes direct character and paragraph formatting against the style", async () => {
		const result = await convert({
			pieces: [{ text: "plain bold\r" }],
			runs: [{ start: 6, end: 10, grpprl: prl.toggle(0x0835, 1) }],
			paragraphs: [{ end: 11, grpprl: prl.u8(0x2461, 1) }]
		})
		const document = part(result, "word/document.xml")

		expect(document).toContain('<w:jc w:val="center"/>')
		expect(document).toMatch(
			/<w:r><w:t xml:space="preserve">plain <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">bold<\/w:t><\/w:r>/u
		)
		expect(docxBodyText(await reopen(result))).toBe("plain bold")
	})

	it("maps the kashida and Thai sprmPJc values to their ST_Jc names", async () => {
		const result = await convert({
			pieces: [{ text: "a\rb\rc\rd\r" }],
			paragraphs: [
				{ end: 2, grpprl: prl.u8(0x2461, 5) },
				{ end: 4, grpprl: prl.u8(0x2461, 7) },
				{ end: 6, grpprl: prl.u8(0x2461, 8) },
				{ end: 8, grpprl: prl.u8(0x2461, 9) }
			]
		})
		const jc = [...part(result, "word/document.xml").matchAll(/<w:jc w:val="([^"]+)"\/>/gu)].map(match => match[1])

		expect(jc).toEqual(["mediumKashida", "highKashida", "lowKashida", "thaiDistribute"])
	})

	it("writes styles with what each adds to its base style", async () => {
		const result = await convert({
			pieces: [{ text: "heading\r" }],
			paragraphs: [{ end: 8, istd: 1 }],
			structures: {
				stshf: stsh([
					{ name: "Normal", stk: 1 },
					{ name: "heading 1", stk: 1, base: 0, papx: prl.u8(0x2406, 1), chpx: prl.toggle(0x0835, 1) }
				])
			}
		})
		const styles = part(result, "word/styles.xml")

		expect(styles).toContain('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>')
		expect(styles).toMatch(
			/<w:style w:type="paragraph" w:styleId="heading1"><w:name w:val="heading 1"\/><w:basedOn w:val="Normal"\/>.*<w:pPr><w:keepNext\/><\/w:pPr><w:rPr><w:b\/><\/w:rPr>/u
		)
		expect(styles).toContain("<w:latentStyles")
		expect(part(result, "word/document.xml")).toContain('<w:pStyle w:val="heading1"/>')
	})

	it("gives every style a name of its own, without regard to case, and keeps aliases", async () => {
		const result = await convert({
			pieces: [{ text: "x\r" }],
			structures: {
				stshf: stsh([
					{ name: "Normal", stk: 1 },
					{ name: "Normal ", stk: 1, base: 0 },
					{ name: "normal", stk: 1, base: 0 },
					{ name: "Body,BT,Corps", stk: 1, base: 0 }
				])
			}
		})
		const names = [...part(result, "word/styles.xml").matchAll(/<w:name w:val="([^"]*)"\/>/gu)].map(match => match[1])

		expect(names).toEqual(["Normal", "Normal 2", "normal 3", "Body"])
		expect(part(result, "word/styles.xml")).toContain('<w:name w:val="Body"/><w:aliases w:val="BT,Corps"/>')
	})

	it("turns a base style's list off in a style that has none", async () => {
		const { plfLst, lstLength, plfLfo } = lists([{ nfc: 0, text: "\u0000." }])
		const result = await convert({
			pieces: [{ text: "numbered\runnumbered\r" }],
			paragraphs: [
				{ end: 9, istd: 1 },
				{ end: 20, istd: 2 }
			],
			structures: {
				plfLst,
				plfLfo,
				stshf: stsh([
					{ name: "Normal", stk: 1 },
					{ name: "heading 1", stk: 1, base: 0, papx: prl.u16(0x460b, 1) },
					{ name: "Heading 1 Unnumbered", stk: 1, base: 1, papx: prl.u16(0x460b, 0) }
				])
			},
			lengths: { plfLst: lstLength }
		})
		const styles = part(result, "word/styles.xml")

		expect(styles).toMatch(/w:styleId="heading1">.*?<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/u)
		expect(styles).toMatch(/w:styleId="Heading1Unnumbered">.*?<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="0"\/><\/w:numPr>/u)
	})

	it("lays the document out as Word 97–2003 with the compatibility options its Dop sets", async () => {
		const dop = new Uint8Array(88)

		// copts60 fNoTabForInd (bit 0) and copts80 fDontMakeSpaceForUL (bit 4 of the second word, inverted).
		dop[8] = 0x01
		dop[84] = 0x01
		dop[86] = 0x10
		dop[10] = 0xd0
		dop[11] = 0x02

		const result = await convert({ pieces: [{ text: "x\r" }], structures: { dop } })
		const settings = part(result, "word/settings.xml")

		expect(settings).toContain('<w:defaultTabStop w:val="720"/>')
		expect(settings).toContain(
			'<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="11"/>'
		)
		expect(settings).toContain("<w:noTabHangInd/>")
		expect(settings).not.toContain("<w:spaceForUL/>")
		// Options whose element means the opposite are on when the Word binary flag is off, in schema order.
		expect(compatElements(new Uint8Array(88))).toEqual([
			"spaceForUL",
			"balanceSingleByteDoubleByteWidth",
			"doNotLeaveBackslashAlone",
			"ulTrailSpace",
			"doNotExpandShiftReturn",
			"adjustLineHeightInTable"
		])
	})

	it("keeps read-only protection Word 2002 and later records in the Dop", async () => {
		// Dop2003 follows Dop2002 at Dop byte 594: fTreatLockAtnAsReadOnly is bit 0 of its first byte; at its byte 4,
		// fEnforceDocProt is bit 3 and iDocProtCur bits 4–6.
		const protection = async (setup: (dop: Uint8Array) => void): Promise<RegExpExecArray | null> => {
			const dop = new Uint8Array(616)

			setup(dop)

			const result = await convert({ pieces: [{ text: "x\r" }], structures: { dop }, nFib: 0x10d })

			return /<w:documentProtection w:edit="(\w+)"/u.exec(part(result, "word/settings.xml"))
		}
		const fLockAtn = (dop: Uint8Array): void => new DataView(dop.buffer).setUint32(4, 1 << 20, true)

		// fLockAtn means read-only, not comments, when Dop2003 says so.
		expect(
			(
				await protection(dop => {
					fLockAtn(dop)
					dop[594] = 0x01
				})
			)?.[1]
		).toBe("readOnly")
		expect((await protection(fLockAtn))?.[1]).toBe("comments")

		// The enforced protection Dop2003 names wins over DopBase's flags; 7 is none.
		for (const [current, edit] of [
			[0, "trackedChanges"],
			[1, "comments"],
			[2, "forms"],
			[3, "readOnly"]
		] as const) {
			expect((await protection(dop => (dop[598] = 0x08 | (current << 4))))?.[1]).toBe(edit)
		}

		expect(
			await protection(dop => {
				fLockAtn(dop)
				dop[598] = 0x08 | (7 << 4)
			})
		).toBeNull()
	})

	it("keeps endnote placement from DopBase.epc in every version, numbering only before Word 2002", async () => {
		// epc is bits 0–1 of the u16 at Dop byte 54 (0 end of section, 3 end of document); rncEdn/nEdn the u16 at 52.
		const endnotePr = async (nFib: number, epc: number): Promise<string | undefined> => {
			const dop = new Uint8Array(88)

			dop[54] = epc
			dop[52] = (4 << 2) | 1

			const model = await readDoc(bytesSource(await buildDoc({ pieces: [{ text: "x\r" }], structures: { dop }, nFib })))

			return /<w:endnotePr>.*?<\/w:endnotePr>/u.exec(settingsPart(model, { footnotes: true, endnotes: true }))?.[0]
		}
		const separators = '<w:endnote w:id="-1"/><w:endnote w:id="0"/>'

		expect(await endnotePr(0x10d, 0)).toBe(`<w:endnotePr><w:pos w:val="sectEnd"/>${separators}</w:endnotePr>`)
		expect(await endnotePr(0x10d, 3)).toBe(`<w:endnotePr><w:pos w:val="docEnd"/>${separators}</w:endnotePr>`)
		expect(await endnotePr(0xc1, 0)).toBe(
			`<w:endnotePr><w:pos w:val="sectEnd"/><w:numStart w:val="4"/><w:numRestart w:val="eachSect"/>${separators}</w:endnotePr>`
		)
	})

	// Three spins of Word's 100,000 SHA-1s.
	it("carries a protection password over as the hash of its key, so the same password lifts it", { timeout: 30_000 }, async () => {
		const dop = new Uint8Array(88)
		const key = legacyPasswordVerifier(Uint8Array.from("Example", c => c.charCodeAt(0)))

		// fProtEnabled (bit 25 of the flags at 4); lKeyProtDoc at 78.
		new DataView(dop.buffer).setUint32(4, 1 << 25, true)
		new DataView(dop.buffer).setUint32(78, key, true)

		const spec = { pieces: [{ text: "form\r" }], structures: { dop } }
		const result = await convertDocToDocx(bytesSource(await buildDoc(spec)), {
			protectionKey: verifier => hashLegacyProtectionKey(verifier)
		})
		const hash = readProtectionHash((await reopen(result)).settings, "documentProtection")

		expect(part(result, "word/settings.xml")).toMatch(
			/<w:documentProtection w:edit="forms" w:enforcement="1" w:cryptProviderType="rsaFull"/u
		)
		expect(result.notConverted).toEqual([])

		if (hash === undefined || hash === "unsupported") throw new Error("no hash read back")

		expect(await verifyProtectionPassword(hash, "Example")).toBe("correct")
		expect(await verifyProtectionPassword(hash, "example")).toBe("wrong")

		// Where no hash can be made the restriction stays, and the lost password is reported.
		const without = await convert(spec)

		expect(part(without, "word/settings.xml")).toContain('<w:documentProtection w:edit="forms" w:enforcement="1"/>')
		expect(without.notConverted).toEqual([{ kind: "passwordProtection", count: 1 }])
	})

	it("writes fields as complex fields: instruction text, separator, result", async () => {
		const text = "\u0013 PAGE \u00141\u0015\r"
		const result = await convert({
			pieces: [{ text }],
			runs: [
				{ start: 0, end: 1, grpprl: prl.toggle(0x0855, 1) },
				{ start: 7, end: 8, grpprl: prl.toggle(0x0855, 1) },
				{ start: 9, end: 10, grpprl: prl.toggle(0x0855, 1) }
			],
			structures: {
				plcfFldMom: plc(
					[0, 7, 9, 11],
					[
						[0x13, 33],
						[0x14, 0],
						[0x15, 0x80]
					]
				)
			}
		})
		const document = part(result, "word/document.xml")

		expect(document).toMatch(
			/<w:fldChar w:fldCharType="begin"\/>.*<w:instrText xml:space="preserve"> PAGE <\/w:instrText>.*<w:fldChar w:fldCharType="separate"\/>.*<w:t xml:space="preserve">1<\/w:t>.*<w:fldChar w:fldCharType="end"\/>/u
		)
		expect(docxBodyText(await reopen(result))).toBe("1")
	})

	it("keeps field characters a PLC misses as a field when they nest", async () => {
		const result = await convert({
			pieces: [{ text: 'a\u0013 XE "b" \u0015c\r' }],
			runs: [
				{ start: 1, end: 2, grpprl: prl.toggle(0x0855, 1) },
				{ start: 10, end: 11, grpprl: prl.toggle(0x0855, 1) }
			]
		})

		expect(docxBodyText(await reopen(result))).toBe("ac")
	})

	it("writes a table with its grid, cell widths and row marks", async () => {
		const inTable = prl.u8(0x2416, 1)
		// sprmTDefTable: cb, itcMac 2, rgdxaCenter 0, 2000, 5000, then two TC80s.
		const def = [0x08, 0xd6, 1 + 1 + 6 + 40, 0, 2, 0, 0, 0xd0, 0x07, 0x88, 0x13, ...new Array<number>(40).fill(0)]
		const result = await convert({
			pieces: [{ text: "a\u0007b\u0007\u0007after\r" }],
			paragraphs: [
				{ end: 2, grpprl: inTable },
				{ end: 4, grpprl: inTable },
				{ end: 5, grpprl: [...inTable, ...prl.u8(0x2417, 1), ...def] },
				{ end: 11 }
			]
		})
		const document = part(result, "word/document.xml")

		expect(document).toContain('<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>')
		expect(document).toContain('<w:tcW w:w="3000" w:type="dxa"/>')
		expect(document.match(/<w:tc>/gu)).toHaveLength(2)
		expect(docxBodyText(await reopen(result))).toBe("a\nb\nafter")
	})

	it("shows an inline picture from the Data stream as a media part", async () => {
		const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4)
		const data = inlinePictureData(png, 1440, 720)
		const result = await convert({
			pieces: [{ text: "x\u0001y\r" }],
			runs: [{ start: 1, end: 2, grpprl: [...prl.toggle(0x0855, 1), ...prl.u32(0x6a03, 0)] }],
			streams: [{ path: ["Data"], bytes: data }]
		})
		const document = part(result, "word/document.xml")

		expect(result.parts.get("word/media/image1.png")).toEqual(png)
		expect(document).toContain('<wp:extent cx="914400" cy="457200"/>')
		expect(document).toMatch(/<a:blip r:embed="rId\d+"\/>/u)
		expect(part(result, "[Content_Types].xml")).toContain('<Default Extension="png" ContentType="image/png"/>')
		expect(result.notConverted).toEqual([])
	})

	it("shows an embedded object's picture and reports that its data is not carried over", async () => {
		const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9)
		const special = prl.toggle(0x0855, 1)
		const result = await convert({
			pieces: [{ text: "\u0013 EMBED Package \u0014\u0001\u0015\r" }],
			runs: [
				{ start: 0, end: 1, grpprl: special },
				{ start: 16, end: 17, grpprl: special },
				{ start: 17, end: 18, grpprl: [...special, ...prl.u32(0x6a03, 0)] },
				{ start: 18, end: 19, grpprl: special }
			],
			structures: {
				plcfFldMom: plc(
					[0, 16, 18, 20],
					[
						[0x13, 0x3a],
						[0x14, 0],
						[0x15, 0x80]
					]
				)
			},
			streams: [{ path: ["Data"], bytes: inlinePictureData(png, 720, 720) }]
		})

		expect(result.parts.get("word/media/image1.png")).toEqual(png)
		expect(result.notConverted).toEqual([{ kind: "embeddedObject", count: 1 }])
	})

	it("shows an inline picture whose BLIP is in the document's BLIP store", async () => {
		const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7)
		const result = await convert({
			pieces: [{ text: "\u0001\r" }],
			runs: [{ start: 0, end: 1, grpprl: [...prl.toggle(0x0855, 1), ...prl.u32(0x6a03, 0)] }],
			structures: { dggInfo: drawingGroup(png) },
			streams: [{ path: ["Data"], bytes: inlinePictureData(undefined, 1440, 1440) }]
		})

		expect(result.parts.get("word/media/image1.png")).toEqual(png)
		expect(result.notConverted).toEqual([])
	})

	it("shows a placeholder for a picture it cannot read, and reports it", async () => {
		const result = await convert({
			pieces: [{ text: "x\u0001y\r" }],
			runs: [{ start: 1, end: 2, grpprl: [...prl.toggle(0x0855, 1), ...prl.u32(0x6a03, 0x40)] }],
			streams: [{ path: ["Data"], bytes: new Uint8Array(16) }]
		})

		expect(result.notConverted).toEqual([{ kind: "picture", count: 1 }])
		expect(part(result, "word/document.xml")).toContain('descr="Not converted"')
		expect(result.parts.has("word/media/image1.png")).toBe(true)
	})

	it("stacks floating shapes in their drawing order, not their text order", async () => {
		// FSPA (MS-DOC §2.8.25): spid, the rectangle, flags (wr 3: in front of text), cTxbx.
		const fspa = (spid: number): number[] => {
			const out = new Records()
				.u32(spid)
				.u32(0)
				.u32(0)
				.u32(1440)
				.u32(1440)
				.u16(3 << 5)
				.u32(0)

			return out.bytes
		}
		// The text anchors the ellipse (1027) before the rectangle (1026), but the drawing lists the rectangle first,
		// so it lies at the bottom.
		const result = await convert({
			pieces: [{ text: "\u0008\u0008\r" }],
			runs: [{ start: 0, end: 2, grpprl: prl.toggle(0x0855, 1) }],
			structures: { dggInfo: drawing([1026, 1], [1027, 3]), plcSpaMom: plc([0, 1, 2], [fspa(1027), fspa(1026)]) }
		})
		const xml = part(result, "word/document.xml")
		const height = (preset: string): number => {
			const at = xml.indexOf(`prst="${preset}"`)
			const open = xml.lastIndexOf("<wp:anchor", at)

			return Number(/relativeHeight="(\d+)"/u.exec(xml.slice(open, at))?.[1])
		}

		expect(xml.indexOf('prst="ellipse"')).toBeLessThan(xml.indexOf('prst="rect"'))
		expect(height("rect")).toBeLessThan(height("ellipse"))
		expect(result.notConverted).toEqual([])
	})

	it("reports the macros and AutoText a .docx does not hold", async () => {
		// A template (fDot) whose FibBase.pnNext names the page of its AutoText document (MS-DOC §2.5.2).
		const result = await convert({
			pieces: [{ text: "x\r" }],
			flags: 0x0200 | 0x0001,
			pnNext: 4,
			streams: [{ path: ["Macros", "VBA", "dir"], bytes: new Uint8Array(16) }]
		})

		expect(result.notConverted).toEqual([
			{ kind: "macros", count: 1 },
			{ kind: "autoText", count: 1 }
		])

		// A Macros storage without a VBA project is not one; pnNext means nothing outside a template.
		const empty = await convert({
			pieces: [{ text: "x\r" }],
			pnNext: 4,
			streams: [{ path: ["Macros", "PROJECT"], bytes: new Uint8Array(8) }]
		})

		expect(empty.notConverted).toEqual([])
	})

	it("refuses what it cannot read with the reader's typed error", async () => {
		const legacy = await buildDoc({ pieces: [{ text: "old\r" }], nFib: 0x65, wIdent: 0xa5dc })
		const encrypted = await buildDoc({ pieces: [{ text: "x\r" }], flags: 0x0200 | 0x0100, tablePrefix: Uint8Array.of(1, 0, 1, 0) })

		await expect(convertDocToDocx(bytesSource(legacy))).rejects.toMatchObject({ name: "DocError", code: "legacyVersion" })
		await expect(convertDocToDocx(bytesSource(encrypted))).rejects.toMatchObject({ code: "encrypted", encryption: "rc4" })
		await expect(convertDocToDocx(bytesSource(new Uint8Array(64)))).rejects.toBeInstanceOf(DocError)
	})
})

// OfficeArt records ([MS-ODRAW] §2.1): a record header, then its data.
class Records {
	readonly bytes: number[] = []

	u8(value: number): this {
		this.bytes.push(value & 0xff)
		return this
	}

	u16(value: number): this {
		return this.u8(value).u8(value >>> 8)
	}

	u32(value: number): this {
		return this.u16(value & 0xffff).u16(value >>> 16)
	}

	header(version: number, instance: number, type: number, length: number): this {
		return this.u16(version | (instance << 4))
			.u16(type)
			.u32(length)
	}

	raw(values: ArrayLike<number>): this {
		for (let k = 0; k < values.length; k++) this.u8(values[k] ?? 0)
		return this
	}
}

// An FBSE (§2.2.32) holding a PNG BLIP (§2.2.28).
function fbse(png: Uint8Array): number[] {
	const blipLength = 8 + 17 + png.length
	const out = new Records()
		.header(2, 6, 0xf007, 36 + blipLength)
		.u8(6)
		.u8(6)

	for (let k = 0; k < 16; k++) out.u8(k)

	out.u16(0)
		.u32(blipLength)
		.u32(1)
		.u32(0)
		.u32(0)
		.header(0, 0x6e0, 0xf01e, 17 + png.length)

	for (let k = 0; k < 16; k++) out.u8(k)

	return out.u8(0xff).raw(png).bytes
}

// OfficeArtContent (MS-DOC §2.9.172) with a BLIP store of one PNG, and no drawings.
function drawingGroup(png: Uint8Array): Uint8Array {
	const store = fbse(png)
	const out = new Records()
		.header(0xf, 0, 0xf000, 8 + store.length)
		.header(0xf, 1, 0xf001, store.length)
		.raw(store)

	return Uint8Array.from(out.bytes)
}

// OfficeArtContent with no BLIP store and the main document's drawing: a patriarch group holding the given shapes
// ([spid, MSOSPT]) in that order.
function drawing(...shapes: readonly (readonly [number, number])[]): Uint8Array {
	const shape = (spid: number, type: number, flags: number): number[] =>
		new Records().header(0xf, 0, 0xf004, 16).header(2, type, 0xf00a, 8).u32(spid).u32(flags).bytes
	const children = [shape(1024, 0, 0x5), ...shapes.map(([spid, type]) => shape(spid, type, 0xa00))].flat()
	const group = new Records().header(0xf, 0, 0xf003, children.length).raw(children).bytes
	const container = new Records().header(0xf, 0, 0xf002, group.length).raw(group).bytes

	return Uint8Array.from(new Records().header(0xf, 0, 0xf000, 0).u8(0).raw(container).bytes)
}

// A PICF (§2.9.192, MM_SHAPE) with an inline shape (FSP + OPT pib 1), followed by the FBSE holding the PNG BLIP, or
// by nothing when the BLIP is in the document's BLIP store.
function inlinePictureData(png: Uint8Array | undefined, width: number, height: number): Uint8Array {
	const blip = png === undefined ? [] : fbse(png)
	const spLength = 8 + 8 + 8 + 6
	const out = new Records()
		.u32(0x44 + 8 + spLength + blip.length)
		.u16(0x44)
		.u16(0x64)

	while (out.bytes.length < 28) out.u8(0)

	out.u16(width).u16(height).u16(1000).u16(1000)

	while (out.bytes.length < 0x44) out.u8(0)

	out.header(0xf, 0, 0xf004, spLength).header(2, 75, 0xf00a, 8).u32(1025).u32(0xa00).header(3, 1, 0xf00b, 6).u16(0x4104).u32(1)

	return Uint8Array.from(out.raw(blip).bytes)
}
