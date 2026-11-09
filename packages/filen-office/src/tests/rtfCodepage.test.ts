import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { codepageSupported, decodeCodepage } from "../core/rtf/codepage"
import { readRtf } from "../core/rtf/index"
import { encodeText } from "../core/rtf/write/encode"

function bytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length)

	for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 0xff

	return out
}

function hex(values: readonly number[]): Uint8Array {
	return Uint8Array.from(values)
}

async function decoded(rtf: string): Promise<{ text: string; unsupported: readonly number[] }> {
	const result = await readRtf(bytes(rtf))

	if (!result.ok) throw new Error(result.reason)

	const xml = strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array())
	const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]).join("")

	return { text, unsupported: result.unsupportedCodepages }
}

describe("RTF code pages", () => {
	it("decodes DOS \\pc and \\pca documents through code pages 437 and 850", async () => {
		const pc = await decoded("{\\rtf1\\pc{\\fonttbl{\\f0 Courier;}}\\f0 \\'c9\\'cd\\'bb \\'82\\'e1\\par}")

		expect(pc.text).toBe("╔═╗ éß")
		expect(pc.unsupported).toEqual([])

		const pca = await decoded("{\\rtf1\\pca{\\fonttbl{\\f0 Courier;}}\\f0 \\'d5\\'b5\\'9b\\par}")

		expect(pca.text).toBe("ıÁø")
		expect(pca.unsupported).toEqual([])
	})

	it("decodes Mac single-byte charsets from \\fcharsetN", async () => {
		const result = await decoded(
			"{\\rtf1\\mac{\\fonttbl{\\f0\\fcharset88 CE;}{\\f1\\fcharset85 Greek;}{\\f2\\fcharset86 Turkish;}{\\f3\\fcharset84 Arabic;}}" +
				"\\f0 \\'81\\'8d\\f1 \\'a1\\f2 \\'da\\f3 \\'c7\\par}"
		)

		// 10029 Ā ć, 10006 Γ, 10081 Ğ, 10004 ا.
		expect(result.text).toBe("ĀćΓĞا")
		expect(result.unsupported).toEqual([])
	})

	it("decodes Mac CJK charsets through their Windows supersets", async () => {
		const result = await decoded(
			"{\\rtf1\\mac{\\fonttbl{\\f0\\fcharset78 Osaka;}{\\f1\\fcharset81 Apple LiSung;}{\\f2\\fcharset79 AppleGothic;}{\\f3\\fcharset80 STSong;}}" +
				"\\f0 \\'82\\'a0\\f1 \\'a4\\'a4\\f2 \\'b0\\'a1\\f3 \\'d6\\'d0\\par}"
		)

		expect(result.text).toBe("あ中가中")
		expect(result.unsupported).toEqual([])
	})

	it("maps the Mac CJK single-byte extras without splitting two-byte characters", () => {
		// Mac Japanese: 0x80 backslash, 0xA0 no-break space, 0xFD-0xFF ©™…; 0x82 0xA0 stays one character.
		expect(decodeCodepage(hex([0x80, 0x82, 0xa0, 0xa0, 0xfd, 0xfe, 0xff]), 0, 7, 10001)).toBe("\\あ ©™…")
		// Mac Traditional Chinese: 0xA4 0xFD is one Big5 character, 0xFD alone is ©.
		expect(decodeCodepage(hex([0x80, 0xa4, 0xfd, 0xfd]), 0, 4, 10002)).toBe("\\王©")
		// Mac Simplified Chinese: 0x80 is ü.
		expect(decodeCodepage(hex([0x80, 0xd6, 0xd0, 0xa0, 0xff]), 0, 5, 10008)).toBe("ü中 …")
	})

	it("reports table-backed code pages as supported without a platform decoder", () => {
		const original = globalThis.TextDecoder

		try {
			Object.defineProperty(globalThis, "TextDecoder", { value: undefined, configurable: true, writable: true })

			for (const codepage of [437, 850, 1252, 10004, 10006, 10029, 10081]) expect(codepageSupported(codepage)).toBe(true)

			expect(decodeCodepage(hex([0xb3, 0x9c]), 0, 2, 437)).toBe("│£")
		} finally {
			Object.defineProperty(globalThis, "TextDecoder", { value: original, configurable: true, writable: true })
		}

		expect(codepageSupported(1361)).toBe(false)
	})

	it("writes fallback bytes in table-backed code pages", () => {
		expect(encodeText("Ł", 10029).rtf).toBe("\\u321\\'fc")
		expect(encodeText("╗", 437).rtf).toBe("\\u9559\\'bb")
	})
})
