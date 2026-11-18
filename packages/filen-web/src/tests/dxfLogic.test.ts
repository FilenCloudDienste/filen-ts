import { describe, expect, it } from "vitest"
import { FALLBACK_FAMILIES, PDF_FACES } from "@filen/office/core/pdfwrite/fonts"
import { DXF_HEADER_BYTES, dwgCodepageLabel, dxfFileEncoding, dxfHeaderFields } from "@/features/preview/lib/dxfEncoding.logic"
import { DXF_MAX_CODE_POINTS, DxfCodePoints, dxfFontFaces, regularFace } from "@/features/preview/lib/dxfFonts.logic"
import { DXF_MAX_ZOOM_IN, DXF_MAX_ZOOM_OUT, panDxfView, zoomDxfView } from "@/features/preview/lib/dxfView.logic"
import { DXF_DEVICE_PIXEL_RATIO, dxfCanvas, dxfContainer } from "@/features/preview/lib/dxfStubs"

function header(variables: readonly (readonly [string, string, string])[], newline = "\r\n"): Uint8Array {
	const lines = ["0", "SECTION", "2", "HEADER", ...variables.flatMap(([name, code, value]) => ["9", name, code, value]), "0", "ENDSEC"]

	return new TextEncoder().encode(lines.join(newline) + newline)
}

describe("dxfHeaderFields", () => {
	it("reads $ACADVER and $DWGCODEPAGE as the parser pairs the lines, whatever the line ends", () => {
		for (const newline of ["\r\n", "\n", "\r"]) {
			expect(
				dxfHeaderFields(
					header(
						[
							["$ACADVER", "1", "AC1015"],
							["$DWGCODEPAGE", "3", "ANSI_1251"]
						],
						newline
					)
				)
			).toEqual({ version: 1015, codepage: "ANSI_1251" })
		}
	})

	it("trims padded codes and values, and keeps the first of a repeated variable", () => {
		const text = "  9\r\n$DWGCODEPAGE\r\n  3\r\n ANSI_1253 \r\n  9\r\n$DWGCODEPAGE\r\n  3\r\nANSI_1250\r\n"

		expect(dxfHeaderFields(new TextEncoder().encode(text))).toEqual({ version: null, codepage: "ANSI_1253" })
	})

	it("does not take a value line for a code line: pairs stay aligned", () => {
		// "9" here is the value of group 1, not a code; the variable after it is not read.
		const text = "1\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_1251\r\n"

		expect(dxfHeaderFields(new TextEncoder().encode(text)).codepage).toBeNull()
	})

	it("reads only the head", () => {
		const padding = "999\r\n" + "x".repeat(DXF_HEADER_BYTES) + "\r\n"
		const late = new TextEncoder().encode(padding + "9\r\n$DWGCODEPAGE\r\n3\r\nANSI_1251\r\n")

		expect(dxfHeaderFields(late).codepage).toBeNull()
	})
})

describe("dwgCodepageLabel", () => {
	it.each([
		["ANSI_1252", "windows-1252"],
		["ansi_1251", "windows-1251"],
		["ANSI_874", "windows-874"],
		["ANSI_932", "shift_jis"],
		["ANSI_936", "gb18030"],
		["ANSI_949", "euc-kr"],
		["ANSI_950", "big5"],
		["ISO8859-1", "windows-1252"],
		["ISO8859-2", "iso-8859-2"],
		["ISO8859-9", "windows-1254"],
		["DOS866", "ibm866"],
		["MACINTOSH", "macintosh"],
		["UTF8", "utf-8"]
	])("%s reads as %s", (codepage, label) => {
		expect(dwgCodepageLabel(codepage)).toBe(label)
		expect(() => new TextDecoder(label)).not.toThrow()
	})

	it.each(["ANSI_1361", "DOS437", "ISO8859-3", "ANSI_", "KOI8", ""])("%s names no decoder here", codepage => {
		expect(dwgCodepageLabel(codepage)).toBeNull()
	})
})

describe("dxfFileEncoding", () => {
	it("reads R2007 and later as UTF-8 whatever the codepage says", () => {
		expect(
			dxfFileEncoding(
				header([
					["$ACADVER", "1", "AC1021"],
					["$DWGCODEPAGE", "3", "ANSI_1251"]
				])
			)
		).toBe("utf-8")
	})

	it("reads an older drawing in its codepage", () => {
		expect(
			dxfFileEncoding(
				header([
					["$ACADVER", "1", "AC1015"],
					["$DWGCODEPAGE", "3", "ANSI_1251"]
				])
			)
		).toBe("windows-1251")
	})

	it("reads a drawing naming no usable codepage as UTF-8 when its head is, else as Windows-1252", () => {
		expect(dxfFileEncoding(new TextEncoder().encode("0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\nCafé\n"))).toBe("utf-8")
		expect(dxfFileEncoding(Uint8Array.from([0x30, 0x0a, 0x54, 0x0a, 0x31, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]))).toBe("windows-1252")
		expect(dxfFileEncoding(header([["$DWGCODEPAGE", "3", "DOS437"]]))).toBe("utf-8")
		// A head cut inside a character is still UTF-8.
		expect(dxfFileEncoding(new TextEncoder().encode("1\nCafé").subarray(0, 6))).toBe("utf-8")
	})
})

describe("DxfCodePoints", () => {
	it("collects the characters past ASCII, written out or escaped, across chunks", () => {
		const points = new DxfCodePoints()

		points.add("TEXT Café \\U+05D")
		points.add("0 and %%c 12 and \\M+1823C")

		expect([...points.codePoints()].sort((a, b) => a - b)).toEqual([0xe9, 0x5d0, 0x2205, 0x3042])
	})

	it("stops collecting at its cap", () => {
		const points = new DxfCodePoints()

		points.add(Array.from({ length: DXF_MAX_CODE_POINTS + 10 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(""))

		expect(points.codePoints().size).toBe(DXF_MAX_CODE_POINTS)
	})
})

describe("dxfFontFaces", () => {
	const primary = regularFace(PDF_FACES.arimo)

	if (primary === undefined) throw new Error("no Arimo face")

	const files = (text: string): string[] => {
		const points = new DxfCodePoints()

		points.add(text)

		return dxfFontFaces(points.codePoints(), primary, FALLBACK_FAMILIES).map(face => face.file)
	}

	it("offers the sans face alone to Latin text", () => {
		expect(files("Plan 1:100 — Café")).toEqual(["arimo/Arimo-Regular.ttf.gz"])
	})

	it("adds the first family covering each script, once, in the families' order", () => {
		const offered = files("שלום 中文 中 한국어 مرحبا")

		expect(offered[0]).toBe("arimo/Arimo-Regular.ttf.gz")
		expect(offered).toContain("noto/noto-naskh-arabic/NotoNaskhArabic-Regular.ttf.gz")
		expect(offered).toContain("noto/noto-sans-hebrew/NotoSansHebrew-Regular.ttf.gz")
		expect(offered).toContain("noto/noto-sans-sc/NotoSansSC-Regular.ttf.gz")
		expect(offered).toContain("noto/noto-sans-kr/NotoSansKR-Regular.ttf.gz")
		// Han is the Simplified Chinese family's first: the other CJK families are not offered for it.
		expect(offered).not.toContain("noto/noto-sans-tc/NotoSansTC-Regular.ttf.gz")
		expect(offered).not.toContain("noto/noto-sans-jp/NotoSansJP-Regular.ttf.gz")
		expect(new Set(offered).size).toBe(offered.length)
	})

	it("offers the symbol and math families for symbols", () => {
		expect(files("%%c")).toContain("noto/noto-sans-math/NotoSansMath-Regular.ttf.gz")
	})
})

describe("dxfView", () => {
	const canvas = { width: 400, height: 200 }

	it("pans with the pointer: the drawing follows it", () => {
		expect(panDxfView({ x: 0, y: 0, width: 100 }, 40, 20, canvas)).toEqual({ x: -10, y: 5, width: 100 })
	})

	it("zooms about a point, which keeps the scene point under it", () => {
		const view = { x: 10, y: 20, width: 100 }
		const at = { x: 300, y: 50 }
		const before = { x: view.x + (at.x - 200) * (100 / 400), y: view.y - (at.y - 100) * (100 / 400) }
		const zoomed = zoomDxfView(view, 2, at, canvas, 100)
		const after = { x: zoomed.x + (at.x - 200) * (zoomed.width / 400), y: zoomed.y - (at.y - 100) * (zoomed.width / 400) }

		expect(zoomed.width).toBe(50)
		expect(after.x).toBeCloseTo(before.x)
		expect(after.y).toBeCloseTo(before.y)
	})

	it("keeps the zoom within its limits of the fitted width, and ignores a factor that is not one", () => {
		const view = { x: 0, y: 0, width: 100 }
		const centre = { x: 200, y: 100 }

		expect(zoomDxfView(view, 1e12, centre, canvas, 100).width).toBe(100 / DXF_MAX_ZOOM_IN)
		expect(zoomDxfView(view, 1e-12, centre, canvas, 100).width).toBe(100 * DXF_MAX_ZOOM_OUT)
		expect(zoomDxfView(view, Number.NaN, centre, canvas, 100)).toBe(view)
		expect(zoomDxfView(view, 0, centre, canvas, 100)).toBe(view)
	})
})

describe("dxfStubs", () => {
	it("gives the viewer a container that holds nothing and a canvas with inert style and ownerDocument", () => {
		const container = dxfContainer(640, 480)

		expect(container.clientWidth).toBe(640)
		expect(container.clientHeight).toBe(480)
		expect(() => {
			container.appendChild()
		}).not.toThrow()

		const target = new EventTarget()
		const canvas = dxfCanvas(target)

		expect(canvas).toBe(target)
		canvas.style["width"] = "640px"
		canvas.ownerDocument.addEventListener("pointermove", () => undefined)
		expect(canvas.style).toEqual({ width: "640px" })
		expect(DXF_DEVICE_PIXEL_RATIO).toBe(1)
	})
})
