import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { RevisionView } from "@filen/office/core/docx"
import { readRtf, type RtfReadResult } from "../core/rtf/index"
import { RtfTokenizer, Token } from "../core/rtf/tokenizer"
import { layOut, pageLines } from "./layoutFixtures"
import { budget } from "./timing"
import { latin1 } from "./rtfLatin1"

async function read(rtf: string | Uint8Array): Promise<RtfReadResult> {
	const result = await readRtf(typeof rtf === "string" ? latin1(rtf) : rtf)

	if (!result.ok) throw new Error(result.reason)

	return result
}

async function parts(rtf: string | Uint8Array): Promise<Record<string, string>> {
	const files = unzipSync((await read(rtf)).docx)
	const out: Record<string, string> = {}

	for (const [name, data] of Object.entries(files)) out[name] = name.startsWith("word/media/") ? `${data.length}` : strFromU8(data)

	return out
}

async function body(rtf: string): Promise<string> {
	return (await parts(rtf))["word/document.xml"] ?? ""
}

// The text a run shows, in order, from w:t elements.
function texts(xml: string): string {
	return [...xml.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<\/w:(?:t|delText)>/gu)].map(match => match[1]).join("")
}

describe("RTF tokenizer", () => {
	it("reads control words with signed parameters and the delimiting space as part of the word", () => {
		const tokens = new RtfTokenizer(latin1("\\fs-24 x\\b0y\\par\r\nz"))

		expect(tokens.next()).toBe(Token.Word)
		expect([tokens.name, tokens.param, tokens.hasParam, tokens.start, tokens.end]).toEqual(["fs", -24, true, 0, 7])
		expect(tokens.next()).toBe(Token.Text)
		expect([tokens.textStart, tokens.textEnd]).toEqual([7, 8])
		expect(tokens.next()).toBe(Token.Word)
		expect([tokens.name, tokens.param]).toEqual(["b", 0])
		expect(tokens.next()).toBe(Token.Text)
		expect(tokens.next()).toBe(Token.Word)
		expect([tokens.name, tokens.hasParam]).toEqual(["par", false])
		// CR and LF are not text.
		expect(tokens.next()).toBe(Token.Text)
		expect([tokens.textStart, tokens.textEnd]).toEqual([18, 19])
		expect(tokens.next()).toBe(Token.End)
	})

	it("jumps over \\bin data, braces in it included, and clamps a length past the end", () => {
		const tokens = new RtfTokenizer(latin1("{\\bin3 {}}x}{\\bin99 ab"))

		expect(tokens.next()).toBe(Token.GroupStart)
		expect(tokens.next()).toBe(Token.Bin)
		expect([tokens.dataStart, tokens.dataEnd, tokens.clamped]).toEqual([7, 10, false])
		expect(tokens.next()).toBe(Token.Text)
		expect(tokens.next()).toBe(Token.GroupEnd)
		expect(tokens.next()).toBe(Token.GroupStart)
		expect(tokens.next()).toBe(Token.Bin)
		expect([tokens.dataStart, tokens.dataEnd, tokens.clamped]).toEqual([20, 22, true])
		expect(tokens.next()).toBe(Token.End)
	})

	it("reads \\'hh as one byte and a broken escape as nothing", () => {
		const tokens = new RtfTokenizer(latin1("\\'e9\\'zq\\{"))

		expect(tokens.next()).toBe(Token.Hex)
		expect(tokens.value).toBe(0xe9)
		expect(tokens.next()).toBe(Token.Hex)
		expect(tokens.value).toBe(-1)
		expect(tokens.next()).toBe(Token.Text)
		expect(tokens.next()).toBe(Token.Symbol)
		expect(tokens.symbol).toBe(0x7b)
	})

	it("skips a group in one pass whatever its depth", () => {
		const nested = "{".repeat(50_000) + "}".repeat(50_000)
		const tokens = new RtfTokenizer(latin1(`${nested}x`))

		tokens.next()
		tokens.skipGroup()

		expect(tokens.position).toBe(100_000)
	})
})

describe("RTF reader", () => {
	it("refuses input that is not RTF", async () => {
		expect(await readRtf(latin1("PK\u0003\u0004"))).toEqual({ ok: false, reason: "notRtf" })
		expect((await readRtf(latin1(" \r\n{\\rtf1 x}"))).ok).toBe(true)
	})

	it("decodes text in each font's code page over the document's", async () => {
		const xml = await body(
			"{\\rtf1\\ansi\\ansicpg1250{\\fonttbl{\\f0\\fcharset0 Arial;}{\\f1\\fcharset204 Arial Cyr;}{\\f2 Plain;}}" +
				"\\f0 \\'e9\\f1 \\'c0\\'e1\\f2 \\'9a\\par}"
		)

		// f0 is Windows-1252, f1 Windows-1251, f2 (no charset) the document's Windows-1250.
		expect(texts(xml)).toBe("\u00e9\u0410\u0431\u0161")
	})

	it("decodes two-byte characters written as \\'hh pairs", async () => {
		const xml = await body("{\\rtf1\\ansi\\ansicpg932{\\fonttbl{\\f0\\fcharset128 MS Mincho;}}\\f0 \\'82\\'a0\\'93\\'fa\\par}")

		expect(texts(xml)).toBe("\u3042\u65e5")
	})

	it("skips \\ucN fallback characters after \\uN, never past a group end", async () => {
		const xml = await body("{\\rtf1 a\\u8364?b{\\uc2\\u8212--c}\\u945 {d}e\\uc0\\u-4064 f\\par}")

		// The fallback after \u945 ends at the group: "d" is shown. U+F020 is \u-4064.
		expect(texts(xml)).toBe("a\u20acb\u2014c\u03b1de\uf020f")
	})

	it("keeps symbol-font codes where Word keeps them and names the font in the document's code page", async () => {
		const files = await parts("{\\rtf1{\\fonttbl{\\f1\\fcharset2 Symbol;}}\\f1 \\'b7\\par}")

		expect(texts(files["word/document.xml"] ?? "")).toBe("\uf0b7")
		expect(files["word/document.xml"]).toContain('w:ascii="Symbol"')
	})

	it("skips unknown \\* destinations and reports their source range", async () => {
		const rtf = "{\\rtf1 a{\\*\\unknownthing hidden {nested}}b\\par}"
		const result = await read(rtf)
		const range = result.preserved.find(entry => entry.name === "unknownthing")

		expect(texts(strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()))).toBe("ab")
		expect(range).toBeDefined()
		expect(rtf.slice(range?.start, range?.end)).toBe("{\\*\\unknownthing hidden {nested}}")
	})

	it("scopes character properties to groups and resets them with \\plain", async () => {
		const xml = await body("{\\rtf1 \\b a{\\i b}c\\plain d\\par}")
		const runs = [...xml.matchAll(/<w:r>(.*?)<\/w:r>/gu)].map(match => match[1] ?? "")

		expect(runs[0]).toContain("<w:b/>")
		expect(runs[1]).toContain("<w:i/>")
		expect(runs[2]).not.toContain("<w:i/>")
		expect(runs[2]).toContain("<w:b/>")
		expect(runs[3]).not.toContain("<w:b/>")
	})

	it("builds tables from \\cellx with merged, nested and missing cells", async () => {
		const xml = await body(
			"{\\rtf1 \\trowd\\trgaph108\\trleft-108\\clmgf\\cellx1000\\clmrg\\cellx2000\\cellx3000" +
				"\\pard\\intbl A\\cell \\cell B\\par" +
				"\\pard\\intbl\\itap2 N1\\nestcell{\\*\\nesttableprops\\trowd\\cellx500\\nestrow}" +
				"\\pard\\intbl after nested\\cell \\row" +
				"\\trowd\\trleft-108\\cellx3000\\cellx4000\\pard\\intbl only\\cell \\row\\pard after\\par}"
		)
		const outer = xml.slice(xml.indexOf("<w:tbl>"), xml.lastIndexOf("</w:tbl>") + 8)

		// Edges -108, 1000, 2000, 3000, 4000: the merged pair spans two grid columns.
		expect(outer.match(/<w:tblGrid>.*?<\/w:tblGrid>/u)?.[0].match(/<w:gridCol /gu)?.length).toBe(4)
		expect(outer).toContain('<w:gridSpan w:val="2"/>')
		// The nested table sits in the second cell, which then goes on.
		expect(outer.indexOf("N1")).toBeGreaterThan(outer.indexOf("B"))
		expect(outer.indexOf("after nested")).toBeGreaterThan(outer.indexOf("N1"))
		expect(outer.match(/<w:tbl>/gu)?.length).toBe(2)
		// The second row has one cell for two definitions: the rest of the grid is w:gridAfter.
		expect(outer).toContain('<w:gridAfter w:val="1"/>')
		expect(texts(xml.slice(xml.lastIndexOf("</w:tbl>")))).toBe("after")
		// The text of the first cell's text lines up with the margin before Word 2013 (indent = left + margin).
		expect(outer).toContain('<w:tblInd w:w="0" w:type="dxa"/>')
	})

	it("writes fields as instructions and results, and computes an empty SYMBOL result", async () => {
		const xml = await body(
			'{\\rtf1 {\\field{\\*\\fldinst {HYPERLINK "https://filen.io"}}{\\fldrslt {link}}} ' +
				'{\\field{\\*\\fldinst SYMBOL 252 \\\\f "Wingdings" \\\\s 12}{\\fldrslt }}\\par}'
		)

		expect(xml).toContain('<w:fldChar w:fldCharType="begin"/>')
		expect(xml).toContain('<w:instrText>HYPERLINK "https://filen.io"</w:instrText>')
		expect(xml).toContain('<w:fldChar w:fldCharType="separate"/>')
		expect(texts(xml)).toContain("link")
		expect(xml).toContain('<w:sym w:font="Wingdings" w:char="F0FC"/>')
		expect(xml.match(/w:fldCharType="end"/gu)?.length).toBe(2)
	})

	it("reads footnotes and endnotes with their reference marks", async () => {
		const files = await parts(
			"{\\rtf1 a{\\super\\chftn}{\\footnote \\pard{\\super\\chftn} note one\\par}b{\\super\\chftn}{\\footnote\\ftnalt \\pard\\chftn  end note\\par}\\par}"
		)
		const document = files["word/document.xml"] ?? ""

		expect(document).toContain('<w:footnoteReference w:id="1"/>')
		expect(document).toContain('<w:endnoteReference w:id="1"/>')
		expect(files["word/footnotes.xml"]).toContain("<w:footnoteRef/>")
		expect(texts(files["word/footnotes.xml"] ?? "")).toContain("note one")
		expect(texts(files["word/endnotes.xml"] ?? "")).toContain("end note")
	})

	it("gives each section its page setup and headers, the next section inheriting them", async () => {
		const files = await parts(
			"{\\rtf1\\paperw11906\\paperh16838\\sectd\\titlepg{\\header \\pard Running head\\par}{\\headerf \\pard First head\\par}" +
				"one\\sect \\sectd\\lndscpsxn\\pgwsxn16838\\pghsxn11906\\sbknone two\\par}"
		)
		const document = files["word/document.xml"] ?? ""
		const first = document.slice(0, document.indexOf("</w:p>"))
		const last = document.slice(document.lastIndexOf("<w:sectPr>"))

		expect(first).toContain('<w:headerReference w:type="default"')
		expect(first).toContain('<w:headerReference w:type="first"')
		expect(first).toContain("<w:titlePg/>")
		expect(first).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
		expect(last).toContain('<w:type w:val="continuous"/>')
		expect(last).toContain('w:orient="landscape"')
		expect(last).not.toContain("headerReference")
		expect(texts(files["word/header1.xml"] ?? "")).toBe("Running head")
	})

	it("keeps a section's headers past a \\sectd within it, and its page setup past one inside its footer, as Word writes after a field", async () => {
		const files = await parts(
			"{\\rtf1\\paperw11906\\paperh16838\\sectd\\pgwsxn12240\\pghsxn15840{\\headerr \\pard Running head\\par}" +
				"{\\footerl \\pard {\\field{\\*\\fldinst PAGE}{\\fldrslt }}\\sectd \\ltrsect\\linex0 \\par}{\\footerr \\pard Foot\\par}" +
				"\\pard one {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}}\\sectd \\linex0\\pgwsxn12240\\pghsxn15840 two\\par}"
		)
		const section = /<w:sectPr>.*<\/w:sectPr>/su.exec(files["word/document.xml"] ?? "")?.[0] ?? ""

		expect(section).toContain('<w:headerReference w:type="default"')
		expect(section).toContain('<w:footerReference w:type="default"')
		expect(section).toContain('<w:footerReference w:type="even"')
		expect(section).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
		expect(texts(files["word/header1.xml"] ?? "")).toBe("Running head")
	})

	it("turns HTML paragraph auto spacing off unless the document turns it on (\\htmautsp)", async () => {
		const off = (await parts("{\\rtf1\\pard one\\par}"))["word/settings.xml"] ?? ""
		const on = (await parts("{\\rtf1\\htmautsp\\pard one\\par}"))["word/settings.xml"] ?? ""

		expect(off).toContain("<w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat></w:settings>")
		expect(on).not.toContain("doNotUseHTMLParagraphAutoSpacing")
	})

	it("numbers only paragraphs that name a list, showing \\listtext where none applies", async () => {
		const files = await parts(
			"{\\rtf1{\\*\\listtable{\\list\\listtemplateid1{\\listlevel\\levelnfc4\\levelstartat1{\\leveltext\\'02\\'00);}{\\levelnumbers\\'01;}\\fi-360\\li720}\\listid7}}" +
				"{\\*\\listoverridetable{\\listoverride\\listid7\\listoverridecount0\\ls1}}" +
				"{\\stylesheet{\\s0 Normal;}{\\s2\\ls1 Listed;}}" +
				"{\\listtext a)\\tab}\\pard\\ls1\\ilvl0 first\\par" +
				"\\pard\\s2 styled only\\par" +
				"{\\pntext 9.\\tab}\\pard old style\\par}"
		)
		const document = files["word/document.xml"] ?? ""

		expect(files["word/numbering.xml"]).toContain('<w:lvlText w:val="%1)"/>')
		expect(files["word/numbering.xml"]).toContain('<w:numFmt w:val="lowerLetter"/>')
		expect(document).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
		expect(files["word/styles.xml"]).not.toContain("<w:numPr>")
		// The numbered paragraph drops its \listtext; the old-style one shows it.
		expect(texts(document)).toBe("firststyled only9.old style")
	})

	it("reads PNG pictures in hex and in \\bin, sized by the goal size and scale", async () => {
		// A 1×1 PNG.
		const png = Uint8Array.from(
			atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
			character => character.charCodeAt(0)
		)
		const hex = [...png].map(byte => byte.toString(16).padStart(2, "0")).join("")
		const head = latin1(
			`{\\rtf1 {\\pict\\pngblip\\picw1\\pich1\\picwgoal1440\\pichgoal720\\picscalex50\\picscaley100 ${hex}}{\\pict\\pngblip\\bin${png.length} `
		)
		const tail = latin1("}\\par}")
		const rtf = new Uint8Array(head.length + png.length + tail.length)

		rtf.set(head)
		rtf.set(png, head.length)
		rtf.set(tail, head.length + png.length)

		const files = await parts(rtf)
		const document = files["word/document.xml"] ?? ""

		expect(files["word/media/image1.png"]).toBe(`${png.length}`)
		expect(files["word/media/image2.png"]).toBe(`${png.length}`)
		// 1440 twips at 50 % wide, 720 tall: 457200 × 457200 EMU.
		expect(document).toContain('<wp:extent cx="457200" cy="457200"/>')
		expect(files["[Content_Types].xml"]).toContain('Extension="png"')
		expect(files["word/_rels/document.xml.rels"]).toContain('Target="media/image1.png"')
	})

	it("gives a Windows metafile the placeable header RTF leaves out", async () => {
		// META_HEADER, SETWINDOWORG(0,0), SETWINDOWEXT(100,200), EOF.
		const words = [1, 9, 0x300, 0, 0, 0, 0, 0, 0, 5, 0, 0x20b, 0, 0, 5, 0, 0x20c, 200, 100, 3, 0, 0]
		const hex = words
			.map(word => (word & 0xff).toString(16).padStart(2, "0") + ((word >> 8) & 0xff).toString(16).padStart(2, "0"))
			.join("")
		const result = await read(`{\\rtf1 {\\pict\\wmetafile8\\picw1000\\pich2000\\picwgoal1440\\pichgoal2880 ${hex}}\\par}`)
		const media = unzipSync(result.docx)["word/media/image1.wmf"]

		expect(media).toBeDefined()

		const view = new DataView((media as Uint8Array).buffer, (media as Uint8Array).byteOffset)

		expect(view.getUint32(0, true)).toBe(0x9ac6cdd7)
		expect([view.getInt16(10, true), view.getInt16(12, true)]).toEqual([100, 200])
		// 100 logical units over 1440 twips: 100 units per inch.
		expect(view.getUint16(14, true)).toBe(100)
	})

	it("anchors a shape's picture where the shape is and keeps the shape in the source", async () => {
		const png =
			"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fccf00010f00048501808a98c8210000000049454e44ae426082"
		const result = await read(
			`{\\rtf1 x{\\shp{\\*\\shpinst\\shpleft100\\shptop200\\shpright1540\\shpbottom920\\shpbxpage\\shpbypage\\shpwr3{\\sp{\\sn pib}{\\sv {\\pict\\pngblip ${png}}}}}{\\shprslt {\\pict\\pngblip ${png}}}}y\\par}`
		)
		const document = strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array())

		expect(document).toContain('<wp:positionH relativeFrom="page"><wp:posOffset>63500</wp:posOffset>')
		expect(document).toContain('<wp:extent cx="914400" cy="457200"/>')
		expect(document).toContain("<wp:wrapNone/>")
		// The fallback picture is not shown a second time.
		expect(document.match(/<w:drawing>/gu)?.length).toBe(1)
		expect(result.preserved.some(entry => entry.kind === "shape")).toBe(true)
	})

	it("marks inserted and deleted text with the revision table's authors and dates", async () => {
		const xml = await body(
			"{\\rtf1{\\*\\revtbl{Unknown;}{Ada;}}a{\\revised\\revauth1\\revdttm1767639360 b}{\\deleted\\revauthdel1 c}\\par}"
		)

		expect(xml).toMatch(/<w:ins w:id="\d+" w:author="Ada" w:date="\d{4}-\d\d-\d\dT\d\d:\d\d:00Z"><w:r><w:t>b<\/w:t><\/w:r><\/w:ins>/u)
		expect(xml).toMatch(/<w:del w:id="\d+" w:author="Ada"><w:r><w:delText>c<\/w:delText><\/w:r><\/w:del>/u)
	})

	it("reads comments with their ranges, author and initials", async () => {
		const files = await parts(
			"{\\rtf1 {\\*\\atrfstart 7}said{\\*\\atrfend 7}{\\*\\atnid JS}{\\*\\atnauthor Jane Smith}\\chatn{\\*\\annotation{\\*\\atnref 7}\\pard\\chatn Why?\\par}\\par}"
		)
		const document = files["word/document.xml"] ?? ""

		expect(document).toContain('<w:commentRangeStart w:id="0"/>')
		expect(document).toContain('<w:commentRangeEnd w:id="0"/>')
		expect(document).toContain('<w:commentReference w:id="0"/>')
		expect(files["word/comments.xml"]).toContain('w:author="Jane Smith" w:initials="JS"')
		expect(texts(files["word/comments.xml"] ?? "")).toBe("Why?")
	})

	it("reads document information into core properties", async () => {
		const files = await parts("{\\rtf1{\\info{\\title Report}{\\author Ada}{\\creatim\\yr2024\\mo2\\dy3\\hr4\\min5}}x\\par}")

		expect(files["docProps/core.xml"]).toContain("<dc:title>Report</dc:title>")
		expect(files["docProps/core.xml"]).toContain("<dc:creator>Ada</dc:creator>")
		expect(files["docProps/core.xml"]).toContain(">2024-02-03T04:05:00Z<")
	})

	it("positions framed paragraphs and a Word 95 text box", async () => {
		const xml = await body(
			"{\\rtf1 \\pard\\phpg\\pvpg\\posx720\\posy1440\\absw2880\\wraparound framed\\par" +
				"\\pard{\\*\\do\\dobxpage\\dobypage\\dptxbx{\\dptxbxtext\\pard boxed\\par}\\dpx100\\dpy200\\dpxsize3000\\dpysize400}text\\par}"
		)

		expect(xml).toContain('<w:framePr w:w="2880" w:wrap="around" w:hAnchor="page" w:vAnchor="page" w:x="720" w:y="1440"/>')
		expect(xml).toContain(
			'<w:framePr w:w="3000" w:h="400" w:hRule="atLeast" w:wrap="around" w:hAnchor="page" w:vAnchor="page" w:x="100" w:y="200"/>'
		)
		expect(texts(xml)).toBe("framedboxedtext")
	})

	it("keeps the authors and default font names holding $ as written", async () => {
		const files = await parts(
			"{\\rtf1\\deff0{\\fonttbl{\\f0 A$&B $$ C;}}{\\*\\defchp\\b}{\\*\\revtbl{Unknown;}{R$&D;}{Big $$ Inc;}{Q$`T;}}" +
				"\\pard\\revised\\revauth1\\b one\\par\\revauth2 two\\par\\revauth3 three\\par}"
		)
		const document = files["word/document.xml"] ?? ""
		const styles = files["word/styles.xml"] ?? ""

		expect(document).toMatch(/<w:rPr><w:ins w:id="\d+" w:author="R\$&amp;D"/u)
		expect(document).toMatch(/<w:rPr><w:ins w:id="\d+" w:author="Big \$\$ Inc"/u)
		expect(document).toMatch(/<w:rPr><w:ins w:id="\d+" w:author="Q\$`T"/u)
		expect(document).not.toMatch(/w:author="[^"]*</u)
		expect(styles).toContain('<w:rFonts w:ascii="A$&amp;B $$ C" w:hAnsi="A$&amp;B $$ C"')
	})

	it("ignores a \\do repeated in its group, keeping the text box read under the first", async () => {
		const started = performance.now()
		const xml = await body(
			`{\\rtf1 \\pard{\\*\\do\\dptxbx{\\dptxbxtext\\pard first\\par}${"\\do ".repeat(100_000)}{\\dptxbxtext\\pard second\\par}}text\\par}`
		)

		expect(performance.now() - started).toBeLessThan(budget(2_000))
		expect(texts(xml)).toBe("firstsecondtext")
	})

	it("reads a Word 95 text box nested in another's text", async () => {
		const xml = await body(
			"{\\rtf1 \\pard{\\*\\do\\dptxbx{\\dptxbxtext\\pard outer{\\*\\do\\dptxbx{\\dptxbxtext\\pard inner\\par}}\\par}}text\\par}"
		)

		// The inner box's paragraph ends first, and comes first.
		expect(texts(xml)).toBe("inneroutertext")
	})

	it("ignores bytes after the document's closing brace and reports them", async () => {
		const result = await read("{\\rtf1 kept\\par}\r\n\u00ef\u00bf garbage{\\b more}")

		expect(texts(strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()))).toBe("kept")
		expect(result.preserved.map(entry => entry.kind)).toContain("trailing")
	})

	it("records each paragraph's source range", async () => {
		const rtf = "{\\rtf1 one\\par two\\par{\\header \\pard head\\par}}"
		const result = await read(rtf)
		const ranges = result.paragraphs.map(entry => [entry.story, rtf.slice(entry.start, entry.end)])

		expect(ranges).toEqual([
			["body", "one\\par "],
			["body", "two\\par"],
			["header", "head\\par"]
		])
	})

	it("shows a MACROBUTTON's nested hyperlink text where the field stores no result", async () => {
		const result = await read(
			'{\\rtf1 {\\field{\\*\\fldinst {MACROBUTTON FollowHLink }{\\field{\\*\\fldinst {HYPERLINK "https://filen.io"}}{\\fldrslt {\\ul guidance}}}}}\\par}'
		)
		const layout = await layOut(result.docx)

		expect(pageLines(layout, 0).map(line => line.text)).toEqual(["guidance"])
	})

	it("opens in the docx engine and lays out with headers and notes", async () => {
		const result = await read(
			"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}\\paperw12240\\paperh15840" +
				"{\\header \\pard\\qc Head\\par}Body text{\\super\\chftn}{\\footnote \\pard{\\super\\chftn} Note\\par}\\page Second page\\par}"
		)
		const layout = await layOut(result.docx, { view: RevisionView.Markup })

		expect(layout.pages.length).toBe(2)
		expect(pageLines(layout, 0).map(line => line.text.trim())).toEqual(expect.arrayContaining(["Head", "1 Note"]))
		expect(pageLines(layout, 1).some(line => line.text.includes("Second page"))).toBe(true)
	})
})

describe("RTF reader on hostile input", () => {
	it("skips groups nested past the depth limit, reporting them, in linear time", async () => {
		const deep = `{\\rtf1 a${"{".repeat(200_000)}x${"}".repeat(200_000)}b\\par}`
		const started = performance.now()
		const result = await read(deep)

		expect(performance.now() - started).toBeLessThan(budget(2_000))
		expect(result.preserved.some(entry => entry.kind === "tooDeep")).toBe(true)
		expect(texts(strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()))).toBe("ab")
	})

	it("writes rows of many cell definitions without one cell per definition", async () => {
		const cells = Array.from({ length: 2_000 }, (_, k) => `\\cellx${(k + 1) * 10}`).join("")
		const result = await read(`{\\rtf1 \\trowd${cells}${"\\row".repeat(5_000)}\\pard x\\par}`)
		const document = unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()

		// 5,000 rows of one empty cell and a w:gridAfter each, not 10 million cells.
		expect(document.length).toBeLessThan(2_000_000)
	})

	it("reads \\uN outside the 16-bit range as U+FFFD", async () => {
		const result = await read("{\\rtf1\\uc0 a\\u-327689 b\\u99999999 c\\par}")

		expect(texts(strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()))).toBe("a\ufffdb\ufffdc")
	})

	it("reports a \\bin length past the end of the input", async () => {
		const result = await read("{\\rtf1 {\\pict\\pngblip\\bin1000000 abc}}")

		expect(result.truncatedBinary).toBe(true)
		expect(result.preserved.some(entry => entry.kind === "picture")).toBe(true)
	})

	it("finds an equation's first word once however much white space leads its group", async () => {
		const rtf = `{\\rtf1 \\pard{${"\n".repeat(1_000_000)}\\mmath${"\\i".repeat(50_000)}{\\*\\moMath{\\mr x}}}\\par}`
		const started = performance.now()
		const result = await read(rtf)

		expect(performance.now() - started).toBeLessThan(budget(3_000))
		expect(result.preserved.some(entry => entry.kind === "math")).toBe(true)
	})

	it("reads unclosed groups to the end and reports them", async () => {
		const result = await read("{\\rtf1 {\\b open {\\i deeper")

		expect(result.preserved.some(entry => entry.kind === "unclosedGroup")).toBe(true)
		expect(texts(strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array()))).toBe("open deeper")
	})
})
