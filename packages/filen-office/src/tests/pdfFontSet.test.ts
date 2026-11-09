import { createReadStream, readFileSync } from "node:fs"
import { Readable } from "node:stream"
import { gunzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import type { PdfFaceSource } from "../core/fonts/manager"
import { symbolTable, symbolText } from "../core/fonts/symbols"
import { PdfName, PdfRaw, PdfRef, type PdfDict, type PdfValue } from "../core/pdfwrite/objects"
import type { PdfObjectSink, PdfStreamData } from "../core/pdfwrite/writer"
import { readFace, type PdfByteStream, type PdfFontAssets } from "../core/pdfwrite/fonts/assets"
import { PDF_FACES } from "../core/pdfwrite/fonts/faces.generated"
import { PdfFontSet, SHAPE_CAPS, SHAPE_HYPHEN, type PdfFontFaceRequest, type PdfGlyphRun } from "../core/pdfwrite/fonts/fontSet"

const ASSETS = new URL("../../assets/fonts/", import.meta.url)

function stream(bytes: Uint8Array): PdfByteStream {
	return Readable.toWeb(Readable.from([Buffer.from(bytes)])) as unknown as PdfByteStream
}

const assets: PdfFontAssets = {
	open: file => Promise.resolve(Readable.toWeb(createReadStream(new URL(file, ASSETS))) as unknown as PdfByteStream)
}

function assetBytes(file: string): Uint8Array {
	return new Uint8Array(gunzipSync(readFileSync(new URL(file, ASSETS))))
}

// Captures what fonts write.
class Sink implements PdfObjectSink {
	readonly objects = new Map<number, PdfValue>()
	readonly streams = new Map<number, { readonly dict: PdfDict; readonly data: Uint8Array }>()
	readonly signal = undefined
	readonly deterministic = true
	private next = 1

	allocate(): PdfRef {
		return new PdfRef(this.next++)
	}

	object(ref: PdfRef, value: PdfValue): void {
		this.objects.set(ref.id, value)
	}

	stream(ref: PdfRef, dict: PdfDict, data: PdfStreamData): Promise<void> {
		this.streams.set(ref.id, { dict, data: data as Uint8Array })

		return Promise.resolve()
	}
}

function dict(value: PdfValue | undefined): PdfDict {
	if (
		value === null ||
		value === undefined ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof PdfName ||
		value instanceof PdfRef ||
		value instanceof PdfRaw
	) {
		throw new Error("not a dictionary")
	}

	return value as PdfDict
}

function ref(value: PdfValue | undefined): number {
	if (!(value instanceof PdfRef)) throw new Error("not a reference")

	return value.id
}

interface WrittenFont {
	readonly baseFont: string
	readonly subtype: string
	readonly toUnicode: Map<number, string>
	readonly widths: Map<number, number>
	readonly program: { readonly dict: PdfDict; readonly data: Uint8Array }
	readonly cidToGid: Uint8Array | undefined
}

async function write(fonts: PdfFontSet): Promise<Map<object, WrittenFont>> {
	const out = new Map<object, WrittenFont>()

	for (const font of fonts.fonts()) {
		const sink = new Sink()
		const at = sink.allocate()

		await font.write(sink, at)

		const type0 = dict(sink.objects.get(at.id))
		const cid = dict(sink.objects.get(ref((type0["DescendantFonts"] as readonly PdfValue[])[0])))
		const descriptor = dict(sink.objects.get(ref(cid["FontDescriptor"])))
		const programRef = descriptor["FontFile2"] ?? descriptor["FontFile3"]
		const toUnicode = new Map<number, string>()
		const cmap = new TextDecoder().decode(sink.streams.get(ref(type0["ToUnicode"]))?.data)

		const entries = [...cmap.matchAll(/beginbfchar\n([\s\S]*?)endbfchar/g)].map(block => block[1] ?? "").join("\n")

		for (const [, code, hex] of entries.matchAll(/<([0-9A-F]{4})> <([0-9A-F]*)>/g)) {
			let text = ""

			for (let i = 0; i < (hex ?? "").length; i += 4) text += String.fromCharCode(Number.parseInt((hex ?? "").slice(i, i + 4), 16))

			toUnicode.set(Number.parseInt(code ?? "", 16), text)
		}

		const widths = new Map<number, number>()
		const w = new TextDecoder().decode((cid["W"] as PdfRaw).bytes)

		for (const [, first, list] of w.matchAll(/(\d+) \[([^\]]*)\]/g)) {
			;(list ?? "").split(" ").forEach((value, k) => widths.set(Number(first) + k, Number(value)))
		}

		const map = cid["CIDToGIDMap"]

		out.set(font, {
			baseFont: (type0["BaseFont"] as PdfName).name,
			subtype: (cid["Subtype"] as PdfName).name,
			toUnicode,
			widths,
			program: sink.streams.get(ref(programRef)) ?? { dict: {}, data: new Uint8Array() },
			cidToGid: map instanceof PdfRef ? sink.streams.get(map.id)?.data : undefined
		})
	}

	return out
}

const CALIBRI: PdfFontFaceRequest = { family: "Calibri", bold: false, italic: false, slot: "hAnsi" }

async function shape(fonts: PdfFontSet, text: string, request: PdfFontFaceRequest = CALIBRI, level = 0, flags = 0) {
	const pending = fonts.prepare(text, 0, text.length, request)

	if (pending !== undefined) await pending

	return fonts.shape(text, 0, text.length, request, { level, flags })
}

// The text a reader gets from ToUnicode, reading glyphs in logical order (right-to-left runs backwards).
function extracted(runs: readonly PdfGlyphRun[], written: Map<object, WrittenFont>, rtl: boolean): string {
	const ordered = rtl ? [...runs].reverse() : runs
	let text = ""

	for (const run of ordered) {
		const font = written.get(run.font)
		const codes = rtl ? [...run.glyphs].reverse() : [...run.glyphs]

		for (const code of codes) text += font?.toUnicode.get(code) ?? "�"
	}

	return text.replaceAll("⁠", "")
}

const SAMPLES: readonly (readonly [string, string, boolean, string?])[] = [
	["Latin", "The office affords efficient waffles: AVATAR, naïve façade, Ångström.", false],
	["Greek", "Ελληνικά: Καλημέρα κόσμε, ψυχή.", false],
	["Cyrillic", "Съешь же ещё этих мягких французских булок.", false],
	["Hebrew", "שָׁלוֹם עוֹלָם, מה שלומך", true],
	["Arabic", "اللغة العربية جميلة، لا إله إلا الله", true],
	["Devanagari", "हिन्दी भाषा विश्व की प्रमुख भाषा है। क्षत्रिय श्री कर्म", false],
	["Thai", "ภาษาไทยเป็นภาษาราชการ น้ำ ทำ", false],
	["Chinese", "中文简体：你好，世界！", false, "zh-CN"],
	["Japanese", "日本語の文章です。カタカナ、ひらがな。", false, "ja"],
	["Korean", "한국어 문장입니다. 안녕하세요", false, "ko"]
]

describe("PDF font set", () => {
	for (const [name, text, rtl, language] of SAMPLES) {
		it(`gives back the source text through ToUnicode for ${name}`, async () => {
			const fonts = new PdfFontSet({ assets, deterministic: true })
			const shaped = await shape(fonts, text, { ...CALIBRI, language }, rtl ? 1 : 0)
			const written = await write(fonts)

			expect(extracted(shaped.runs, written, rtl)).toBe(text)

			for (const run of shaped.runs) {
				if (run.actualText !== undefined) expect(text).toContain(run.actualText)
			}

			fonts.close()
		})
	}

	it("embeds every font as a Type0 subset with a six-letter tag, widths and a ToUnicode CMap", async () => {
		const fonts = new PdfFontSet({ assets, deterministic: true })

		for (const [, text, rtl, language] of SAMPLES) await shape(fonts, text, { ...CALIBRI, language }, rtl ? 1 : 0)

		const written = await write(fonts)

		expect(written.size).toBeGreaterThanOrEqual(8)

		for (const font of written.values()) {
			expect(font.baseFont).toMatch(/^[A-Z]{6}\+[!-~]+$/)
			expect(font.subtype).toBe("CIDFontType2")
			expect(font.program.data.length).toBeGreaterThan(0)
			expect(font.program.dict["Length1"]).toBe(font.program.data.length)
			expect(font.toUnicode.size).toBe(font.widths.size)
			expect(font.cidToGid?.length).toBe((font.widths.size + 1) * 2)
		}

		fonts.close()
	})

	it("falls back to the script's Noto family when the face lacks it, and to the CJK family the language names", async () => {
		const fonts = new PdfFontSet({ assets })
		const names = async (text: string, language?: string) =>
			(await shape(fonts, text, { ...CALIBRI, language })).runs.map(run => run.font.postScriptName)

		expect(await names("Hello")).toEqual(["Carlito-Regular"])
		expect(await names("مرحبا")).toEqual(["NotoNaskhArabic-Regular"])
		expect(await names("नमस्ते")).toEqual(["NotoSansDevanagari-Regular"])
		expect(await names("漢字", "ja")).toEqual(["NotoSansJP-Regular"])
		expect(await names("漢字", "zh-TW")).toEqual(["NotoSansTC-Regular"])
		expect(await names("漢字")).toEqual(["NotoSansSC-Regular"])
		expect(await names("한글")).toEqual(["NotoSansKR-Regular"])
		expect(await names("Hi مرحبا")).toEqual(["Carlito-Regular", "NotoNaskhArabic-Regular"])
		expect(fonts.missing().size).toBe(0)

		fonts.close()
	})

	it("draws Wingdings bullets and check boxes from the symbol fallback (w:sym, ECMA-376 17.3.2.41)", async () => {
		const fonts = new PdfFontSet({ assets })
		const wingdings = symbolTable("Wingdings")

		if (wingdings === undefined) throw new Error("no Wingdings table")

		// Wingdings 0xA7 ▪, 0xD8 ⮚, 0xFC ✓, 0x76 ❖, 0x71 ❑, then ballot boxes and a check mark after Calibri text.
		const bullets = symbolText(wingdings, "§Øüvq")
		const symbols = (await shape(fonts, bullets, { ...CALIBRI, family: "Wingdings" })).runs.map(run => run.font.postScriptName)
		const mixed = (await shape(fonts, "Done ✓ ☐ ☒ ➢")).runs.map(run => run.font.postScriptName)

		expect(symbols).toContain("NotoSansSymbols2-Regular")
		expect(mixed[0]).toBe("Carlito-Regular")
		expect(mixed).toContain("NotoSansSymbols2-Regular")
		expect(mixed).not.toContain("NotoSansMath-Regular")
		expect(fonts.missing().size).toBe(0)

		fonts.close()
	})

	it("draws math operators of a Cambria Math equation from the math fallback (ECMA-376 22.1)", async () => {
		const fonts = new PdfFontSet({ assets })
		const math = { ...CALIBRI, family: "Cambria Math" }
		const names = (await shape(fonts, "∀x∈A ∃y⊂B ⇒ x≤y ⟹ ⨁ 𝑥", math)).runs.map(run => run.font.postScriptName)

		expect(names).toContain("NotoSansMath-Regular")
		expect(names).not.toContain("NotoSansSymbols2-Regular")
		expect(fonts.missing().size).toBe(0)

		fonts.close()
	})

	it("loads no symbol or math face for symbols the text face has", async () => {
		const fonts = new PdfFontSet({ assets })

		await shape(fonts, "Hello")

		const text = "• → ↔ ≤ ≠ ∑ √ ∞ ©"

		expect(fonts.prepare(text, 0, text.length, CALIBRI)).toBeUndefined()
		expect(fonts.missing().size).toBe(0)

		fonts.close()
	})

	it("loads nothing more for text whose faces are loaded", async () => {
		const fonts = new PdfFontSet({ assets })

		await shape(fonts, "Hello")

		expect(fonts.prepare("World", 0, 5, CALIBRI)).toBeUndefined()

		fonts.close()
	})

	it("keeps /W at the font's own advances and leaves kerning to the run's advances (PDF/UA-1 7.21.5)", async () => {
		const fonts = new PdfFontSet({ assets })
		const shaped = await shape(fonts, "AVATAR Wolf")
		const written = await write(fonts)
		const run = shaped.runs[0]
		const font = written.get(run?.font ?? {})
		const glyphs = Array.from(run?.glyphs ?? [])
		const kerned = glyphs.filter((code, k) => Math.abs((run?.advances[k] ?? 0) - (font?.widths.get(code) ?? 0)) > 1)

		expect(kerned.length).toBeGreaterThan(0)

		for (const code of glyphs) expect(font?.widths.get(code)).toBe(run?.font.advance(code))

		fonts.close()
	})

	it("draws CAPS text upper-cased but keeps the source text, and adds a break's hyphen as a soft hyphen", async () => {
		const fonts = new PdfFontSet({ assets })
		const shaped = await shape(fonts, "straße", CALIBRI, 0, SHAPE_CAPS | SHAPE_HYPHEN)
		const written = await write(fonts)

		expect(extracted(shaped.runs, written, false)).toBe("straße\u00ad")
		expect(shaped.runs[0]?.glyphs.length).toBe(8)
		expect(Array.from(shaped.runs[0]?.clusters ?? [])).toEqual([0, 1, 2, 3, 4, 4, 5, 6])

		fonts.close()
	})

	it("orders bidi level runs for text without a layout", async () => {
		const fonts = new PdfFontSet({ assets })
		const text = "abc שלום 12"
		const pending = fonts.prepare(text, 0, text.length, CALIBRI)

		if (pending !== undefined) await pending

		const shaped = fonts.shape(text, 0, text.length, CALIBRI, { level: 0, flags: 0, bidi: true })
		const clusters = shaped.runs.flatMap(run => Array.from(run.clusters))

		// "abc ", then the right-to-left run "שלום 12" reversed with its number kept left to right (UAX #9 L2).
		expect(clusters).toEqual([0, 1, 2, 3, 9, 10, 8, 7, 6, 5, 4])

		fonts.close()
	})

	it("draws a restricted embedded face with its bundled substitute, and embeds a permitted one", async () => {
		const caladea = assetBytes("caladea/Caladea-Regular.ttf.gz")
		const embedded = (fsType: number): PdfFaceSource => ({
			kind: "embedded",
			key: `doc-${fsType}`,
			read: () => {
				const bytes = caladea.slice()
				const view = new DataView(bytes.buffer)
				const tables = view.getUint16(4)

				for (let t = 0; t < tables; t++) {
					if (String.fromCharCode(...bytes.subarray(12 + t * 16, 16 + t * 16)) === "OS/2")
						view.setUint16(view.getUint32(20 + t * 16) + 8, fsType)
				}

				return Promise.resolve(bytes)
			},
			fsType,
			weight: 400,
			italic: false,
			substitute: "arimo"
		})

		for (const [fsType, expected] of [
			[0x0002, "Arimo-Regular"],
			[0x0200, "Arimo-Regular"],
			[0x0008, "Caladea-Regular"],
			[0x0000, "Caladea-Regular"]
		] as const) {
			const fonts = new PdfFontSet({ assets, resolve: () => embedded(fsType) })
			const shaped = await shape(fonts, "Document", { ...CALIBRI, family: "Embedded" })

			expect(shaped.runs[0]?.font.postScriptName, `fsType ${fsType}`).toBe(expected)

			fonts.close()
		}
	})

	it("embeds a permitted CFF face whole as FontFile3 /OpenType with glyph ids as codes", async () => {
		const box = new Uint8Array(readFileSync(new URL("./fixtures/pdfFonts/box-cff.otf", import.meta.url)))
		const fonts = new PdfFontSet({
			assets,
			resolve: () => ({
				kind: "embedded",
				key: "box",
				read: () => Promise.resolve(box),
				fsType: 0,
				weight: 400,
				italic: false,
				substitute: "arimo"
			})
		})
		const shaped = await shape(fonts, "AA", { ...CALIBRI, family: "Box" })
		const written = await write(fonts)
		const font = written.get(shaped.runs[0]?.font ?? {})

		expect(font?.subtype).toBe("CIDFontType0")
		expect(font?.program.dict["Subtype"]).toEqual(new PdfName("OpenType"))
		expect(font?.program.data).toEqual(box)
		expect(font?.cidToGid).toBeUndefined()
		expect(Array.from(shaped.runs[0]?.glyphs ?? [])).toEqual([1, 1])
		expect(font?.toUnicode.get(1)).toBe("A")

		fonts.close()
	})

	it("draws a CID-keyed CFF face with its substitute", async () => {
		const box = new Uint8Array(readFileSync(new URL("./fixtures/pdfFonts/box-cff.otf", import.meta.url)))
		const view = new DataView(box.buffer)
		const tables = view.getUint16(4)
		let cff = 0

		for (let t = 0; t < tables; t++)
			if (String.fromCharCode(...box.subarray(12 + t * 16, 16 + t * 16)) === "CFF ") cff = view.getUint32(20 + t * 16)

		// The Top DICT is the second INDEX after the header; turn its first operator into ROS (12 30).
		const nameCount = view.getUint16(cff + 4)
		const nameOffSize = box[cff + 6] ?? 1
		const nameEnd = cff + 7 + (nameCount + 1) * nameOffSize - 1 + (box[cff + 7 + nameCount * nameOffSize + nameOffSize - 1] ?? 0)
		const dictOffSize = box[nameEnd + 2] ?? 1
		const dictStart = nameEnd + 3 + 2 * dictOffSize

		box[dictStart] = 139
		box[dictStart + 1] = 12
		box[dictStart + 2] = 30

		const fonts = new PdfFontSet({
			assets,
			resolve: () => ({
				kind: "embedded",
				key: "cid",
				read: () => Promise.resolve(box),
				fsType: 0,
				weight: 400,
				italic: false,
				substitute: "tinos"
			})
		})
		const shaped = await shape(fonts, "A", { ...CALIBRI, family: "Cid" })

		expect(shaped.runs[0]?.font.postScriptName).toBe("Tinos-Regular")

		fonts.close()
	})

	it("marks faux bold and italic where the face has no such style", async () => {
		const fonts = new PdfFontSet({ assets })
		const bold = await shape(fonts, "مرحبا", { ...CALIBRI, bold: true, italic: true })
		const latin = await shape(fonts, "Bold", { ...CALIBRI, bold: true, italic: true })

		expect(bold.runs[0]?.font.postScriptName).toBe("NotoNaskhArabic-Bold")
		expect([bold.runs[0]?.fauxBold, bold.runs[0]?.fauxItalic]).toEqual([false, true])
		expect([latin.runs[0]?.fauxBold, latin.runs[0]?.fauxItalic]).toEqual([false, false])

		fonts.close()
	})
})

describe("PDF font assets", () => {
	const face = PDF_FACES.selawik[0]
	const file = face?.file ?? ""

	it("decompresses a gzip'd face into a buffer of the manifest's size", async () => {
		const bytes = await readFace(assets, face ?? PDF_FACES.arimo[0]!)

		expect(bytes).toEqual(assetBytes(file))
	})

	it("reads a face the server already decoded as it is", async () => {
		const raw = assetBytes(file)
		const bytes = await readFace({ open: () => Promise.resolve(stream(raw)) }, face ?? PDF_FACES.arimo[0]!)

		expect(bytes).toEqual(raw)
	})

	it("refuses a file larger than the manifest says", async () => {
		const raw = assetBytes(file)
		const longer = new Uint8Array(raw.length + 1)

		longer.set(raw)

		await expect(readFace({ open: () => Promise.resolve(stream(longer)) }, face ?? PDF_FACES.arimo[0]!)).rejects.toThrow(/larger/)
	})
})
