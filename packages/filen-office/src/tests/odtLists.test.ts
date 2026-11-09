import { describe, expect, it } from "vitest"
import { NumberingCounters, parseNumbering } from "../core/docx/numbering/index"
import { PropsStore } from "../core/docx/props/index"
import { xml } from "./docxFixtures"
import { documentXml, partText, translated } from "./odtFixtures"

// Expectations measured on LibreOffice 7.5 over UNO (view cursor positions of each paragraph's first and second
// line), with the same styles as below.
const LIST =
	'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="2cm" fo:text-indent="-0.5cm" fo:margin-left="2cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
const WIDE =
	'<style:style style:name="Wide" style:family="paragraph"><style:paragraph-properties fo:margin-left="5cm" fo:text-indent="1cm"/></style:style>'
const CM = 1440 / 2.54
// A 2 x 2 PNG.
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC"),
	character => character.charCodeAt(0)
)

function paragraphs(xml: string): string[] {
	return xml.split("<w:p>").slice(1)
}

describe("ODT lists", () => {
	it("indents list paragraphs by the level unless their own automatic style sets an indent", async () => {
		const xml = await documentXml({
			styles: `${WIDE}${LIST}`,
			automatic:
				'<style:style style:name="Own" style:family="paragraph"><style:paragraph-properties fo:margin-left="4cm"/></style:style><style:style style:name="Bold" style:family="paragraph" style:parent-style-name="Wide"><style:text-properties fo:font-weight="bold"/></style:style>',
			body: '<text:list text:style-name="L1"><text:list-item><text:p>a</text:p></text:list-item><text:list-item><text:p text:style-name="Own">b</text:p></text:list-item><text:list-item><text:p text:style-name="Wide">c</text:p></text:list-item><text:list-item><text:p text:style-name="Bold">d</text:p></text:list-item></text:list>'
		})
		const [a, b, c, d] = paragraphs(xml)

		// LibreOffice: a, c, d at the level's 2 cm (a common style's indent loses to the list); b at its own 4 cm.
		for (const paragraph of [a, c, d]) expect(paragraph).not.toContain("<w:ind ")
		expect(b).toContain(`<w:ind w:left="${Math.round(4 * CM)}" w:right="0" w:firstLine="0"/>`)
		expect(
			partText(
				await translated({
					styles: LIST,
					body: '<text:list text:style-name="L1"><text:list-item><text:p>x</text:p></text:list-item></text:list>'
				}),
				"word/numbering.xml"
			)
		).toContain(`<w:ind w:left="${Math.round(2 * CM)}" w:hanging="${Math.round(0.5 * CM)}"/>`)
	})

	it("takes an automatic style's indent as a whole: sides it leaves out are zero, not inherited", async () => {
		const xml = await documentXml({
			styles: WIDE,
			automatic:
				'<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Wide"><style:paragraph-properties fo:margin-right="1cm"/></style:style>',
			body: '<text:p text:style-name="P2">x</text:p>'
		})

		// Measured: left and first line at 0 although the parent sets 5 cm and 1 cm.
		expect(xml).toContain(`<w:ind w:left="0" w:right="${Math.round(1 * CM)}" w:firstLine="0"/>`)
	})

	it("numbers headings by the outline style, and leaves a paragraph style's list unnumbered outside text:list", async () => {
		const xml = await documentXml({
			styles: `<style:style style:name="Listed" style:family="paragraph" style:list-style-name="L1"/><text:outline-style style:name="Outline"><text:outline-level-style text:level="1" style:num-format="1" style:num-suffix="."/></text:outline-style>${LIST}`,
			body: '<text:h text:outline-level="1">head</text:h><text:p text:style-name="Listed">plain</text:p>'
		})
		const [heading, plain] = paragraphs(xml)

		expect(heading).toContain('<w:ilvl w:val="0"/>')
		expect(plain).not.toContain("<w:numPr>")
	})

	it("continues a list only when asked, and restarts at a list item's start value", async () => {
		const item = (text: string, start = ""): string => `<text:list-item${start}><text:p>${text}</text:p></text:list-item>`
		const xml = await documentXml({
			styles: LIST,
			body: `<text:list text:style-name="L1" xml:id="first">${item("a")}</text:list><text:list text:style-name="L1">${item("b")}</text:list><text:list text:style-name="L1" text:continue-list="first">${item("c")}${item("d", ' text:start-value="7"')}</text:list>`
		})
		const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => Number(match[1]))

		expect(ids[1]).not.toBe(ids[0])
		expect(ids[2]).toBe(ids[0])
		expect(ids[3]).not.toBe(ids[2])
		expect(
			partText(
				await translated({
					styles: LIST,
					body: `<text:list text:style-name="L1">${item("x", ' text:start-value="7"')}</text:list>`
				}),
				"word/numbering.xml"
			)
		).toContain('<w:startOverride w:val="7"/>')
	})

	it("continues numbering only from the list just before, and only of the same style (ODF 1.3 Part 3 §19.786)", async () => {
		const BULLETS =
			'<text:list-style style:name="L2"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.5cm" fo:margin-left="2cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>'
		const item = (text: string): string => `<text:list-item><text:p>${text}</text:p></text:list-item>`
		const ids = async (body: string): Promise<number[]> =>
			[...(await documentXml({ styles: `${LIST}${BULLETS}`, body })).matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match =>
				Number(match[1])
			)
		const interrupted = await ids(
			`<text:list text:style-name="L1">${item("a")}</text:list><text:list text:style-name="L2">${item("b")}</text:list><text:list text:style-name="L1" text:continue-numbering="true">${item("c")}</text:list>`
		)
		const following = await ids(
			`<text:list text:style-name="L1">${item("a")}</text:list><text:p>between</text:p><text:list text:style-name="L1" text:continue-numbering="true">${item("c")}</text:list>`
		)

		// LibreOffice 7.5 numbers c 1. after the bullet list, and 2. after a paragraph.
		expect(interrupted[2]).not.toBe(interrupted[0])
		expect(following[1]).toBe(following[0])
	})

	it("numbers each new list from its start value, as Word counts the written w:nums (ODF 1.3 Part 3 §19.785, §19.786)", async () => {
		const SUB =
			'<text:list-style style:name="L3"><text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")" text:start-value="3"/></text:list-style>'
		const item = (text: string, inner = ""): string => `<text:list-item><text:p>${text}</text:p>${inner}</text:list-item>`
		const sub = (text: string): string => `<text:list text:style-name="L3">${item(text)}${item(`${text}2`)}</text:list>`
		const translation = await translated({
			styles: `${LIST}${SUB}`,
			body: `<text:list text:style-name="L1">${item("a")}${item("b")}</text:list><text:p/><text:list text:style-name="L1">${item("c")}</text:list><text:p/><text:list text:style-name="L1" text:continue-numbering="true">${item("d")}</text:list><text:p/><text:list text:style-name="L1">${item("e", sub("x"))}${item("f", sub("y"))}</text:list>`
		})
		const store = new PropsStore()
		const counters = new NumberingCounters(parseNumbering(xml(partText(translation, "word/numbering.xml")), store))
		const labels = [...partText(translation, "word/document.xml").matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map(
			match => counters.next(Number(match[2]), Number(match[1]))?.text
		)

		// LibreOffice: a 1. b 2., c restarts at 1., d continues at 2., e restarts; each sublist starts at its c).
		expect(labels).toEqual(["1.", "2.", "1.", "2.", "1.", "c)", "d)", "2.", "c)", "d)"])
	})

	it("labels separate, continued, restarted and interrupted lists as LibreOffice does", async () => {
		const BULLETS =
			'<text:list-style style:name="L2"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>'
		const item = (text: string, start = ""): string => `<text:list-item${start}><text:p>${text}</text:p></text:list-item>`
		const labels = async (body: string): Promise<(string | undefined)[]> => {
			const translation = await translated({ styles: `${LIST}${BULLETS}`, body })
			const counters = new NumberingCounters(parseNumbering(xml(partText(translation, "word/numbering.xml")), new PropsStore()))

			return [...partText(translation, "word/document.xml").matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map(
				match => counters.next(Number(match[2]), Number(match[1]))?.text
			)
		}

		// Two separate lists each count from 1.
		expect(
			await labels(
				`<text:list text:style-name="L1">${item("a")}${item("b")}</text:list><text:list text:style-name="L1">${item("c")}</text:list>`
			)
		).toEqual(["1.", "2.", "1."])
		// text:continue-list continues past a separate list; text:start-value restarts the count.
		expect(
			await labels(
				`<text:list text:style-name="L1" xml:id="first">${item("a")}</text:list><text:list text:style-name="L1">${item("b")}</text:list><text:list text:style-name="L1" text:continue-list="first">${item("c")}${item("d", ' text:start-value="7"')}${item("e")}</text:list>`
			)
		).toEqual(["1.", "1.", "2.", "7.", "8."])
		// text:continue-numbering continues the list just before.
		expect(
			await labels(
				`<text:list text:style-name="L1">${item("a")}${item("b")}</text:list><text:list text:style-name="L1" text:continue-numbering="true">${item("c")}</text:list>`
			)
		).toEqual(["1.", "2.", "3."])
		// A bullet list between them breaks the continuation: c starts again at 1.
		expect(
			await labels(
				`<text:list text:style-name="L1">${item("a")}${item("b")}</text:list><text:list text:style-name="L2">${item("x")}</text:list><text:list text:style-name="L1" text:continue-numbering="true">${item("c")}</text:list>`
			)
		).toEqual(["1.", "2.", "•", "1."])
	})

	it("keeps a new list's restarts of levels not numbered yet when an item restarts a deeper level", async () => {
		const TWO =
			'<text:list-style style:name="L4"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/><text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")"/></text:list-style>'
		const translation = await translated({
			styles: TWO,
			body: '<text:list text:style-name="L4"><text:list-item><text:p>a</text:p></text:list-item><text:list-item><text:p>b</text:p></text:list-item></text:list><text:p/><text:list text:style-name="L4"><text:list-item><text:list><text:list-item text:start-value="5"><text:p>q</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>r</text:p></text:list-item></text:list>'
		})
		const counters = new NumberingCounters(parseNumbering(xml(partText(translation, "word/numbering.xml")), new PropsStore()))
		const labels = [...partText(translation, "word/document.xml").matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map(
			match => counters.next(Number(match[2]), Number(match[1]))?.text
		)

		// r is the second list's first numbered level-1 paragraph: it starts at 1, not after b.
		expect(labels).toEqual(["1.", "2.", "e)", "1."])
	})

	it("adds no level overrides to the first list of a style", async () => {
		const numbering = partText(
			await translated({
				styles: LIST,
				body: '<text:list text:style-name="L1"><text:list-item><text:p>x</text:p></text:list-item></text:list>'
			}),
			"word/numbering.xml"
		)

		expect(numbering).not.toContain("<w:lvlOverride")
	})

	it("flags picture bullets and relative bullet sizes as lossy", async () => {
		const level = (body: string): string => `<text:list-style style:name="L9">${body}</text:list-style>`
		const lossy = async (style: string): Promise<boolean> =>
			(
				await translated({
					styles: style,
					body: '<text:list text:style-name="L9"><text:list-item><text:p>x</text:p></text:list-item></text:list>'
				})
			).lossy.has("listLevel")

		expect(await lossy(level('<text:list-level-style-image text:level="1" xlink:href="Pictures/b.png"/>'))).toBe(true)
		expect(
			await lossy(level('<text:list-level-style-bullet text:level="1" text:bullet-char="•" text:bullet-relative-size="45%"/>'))
		).toBe(true)
		expect(
			await lossy(
				level(
					'<text:list-level-style-number text:level="1" style:num-format="1"><style:text-properties fo:font-size="60%"/></text:list-level-style-number>'
				)
			)
		).toBe(true)
		expect(
			await lossy(level('<text:list-level-style-bullet text:level="1" text:bullet-char="•" text:bullet-relative-size="100%"/>'))
		).toBe(false)
	})

	it("writes a picture bullet as w:numPicBullet with its image related from numbering.xml", async () => {
		const image = (size: string): string =>
			`<text:list-level-style-image text:level="1" xlink:href="Pictures/a.png" xlink:type="simple"><style:list-level-properties ${size}/></text:list-level-style-image>`
		const translation = await translated({
			styles: `<text:list-style style:name="L9">${image('fo:width="0.4cm" fo:height="0.2cm"')}</text:list-style><text:list-style style:name="L8">${image('fo:width="0.4cm" fo:height="0.2cm"')}</text:list-style>`,
			body: '<text:list text:style-name="L9"><text:list-item><text:p>x</text:p></text:list-item></text:list><text:list text:style-name="L8"><text:list-item><text:p>y</text:p></text:list-item></text:list><text:p><draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>',
			extra: [{ name: "Pictures/a.png", data: PNG }]
		})
		const numbering = partText(translation, "word/numbering.xml")
		const width = Math.round((0.4 / 2.54) * 72 * 100) / 100
		const height = Math.round((0.2 / 2.54) * 72 * 100) / 100

		expect(translation.lossy.has("listLevel")).toBe(false)
		// One w:numPicBullet for the same picture and size, ahead of the abstract definitions (CT_Numbering).
		expect(numbering.match(/<w:numPicBullet /g)).toHaveLength(1)
		expect(numbering.indexOf("<w:numPicBullet ")).toBeLessThan(numbering.indexOf("<w:abstractNum "))
		expect(numbering).toContain(`style="width:${width}pt;height:${height}pt" o:bullet="t"><v:imagedata r:id="rId1"`)
		expect(numbering).toContain('<w:lvlText w:val="•"/><w:lvlPicBulletId w:val="0"/><w:lvlJc')
		// The picture's one media part serves the bullet and the frame.
		expect(partText(translation, "word/_rels/numbering.xml.rels")).toContain(
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
		)
		expect([...translation.media]).toEqual([["word/media/image1.png", "Pictures/a.png"]])
		expect(partText(translation, "word/_rels/document.xml.rels")).toContain('Target="media/image1.png"')

		const parsed = parseNumbering(xml(numbering), new PropsStore())

		expect(parsed.pictureBullets.get(0)?.relationshipId).toBe("rId1")
		expect(parsed.level(1, 0)?.level.pictureBulletId).toBe(0)
	})

	it("keeps a plain bullet, flagged, for a picture bullet whose image the translation does not carry", async () => {
		const translation = await translated({
			styles: '<text:list-style style:name="L9"><text:list-level-style-image text:level="1"><office:binary-data>iVBORw0KGgo=</office:binary-data></text:list-level-style-image></text:list-style>',
			body: '<text:list text:style-name="L9"><text:list-item><text:p>x</text:p></text:list-item></text:list>'
		})

		expect(translation.lossy.has("listLevel")).toBe(true)
		expect(partText(translation, "word/numbering.xml")).not.toContain("numPicBullet")
		expect(translation.parts.has("word/_rels/numbering.xml.rels")).toBe(false)
	})

	it("formats a level's label with its character style, the level's own font and size winning", async () => {
		const symbols =
			'<style:style style:name="Base" style:family="text"><style:text-properties fo:color="#C00000" style:font-name="Arial"/></style:style><style:style style:name="Numbering_20_Symbols" style:display-name="Numbering Symbols" style:family="text" style:parent-style-name="Base"><style:text-properties fo:font-weight="bold" fo:font-size="14pt"/></style:style>'
		const numbering = partText(
			await translated({
				styles: `${symbols}<text:list-style style:name="L9"><text:list-level-style-number text:level="1" text:style-name="Numbering_20_Symbols" style:num-format="1"/><text:list-level-style-bullet text:level="2" text:style-name="Numbering_20_Symbols" text:bullet-char="•"><style:text-properties style:font-name="OpenSymbol" fo:font-size="9pt"/></text:list-level-style-bullet><text:list-level-style-number text:level="3" text:style-name="Missing" style:num-format="1"/></text:list-style>`,
				body: '<text:list text:style-name="L9"><text:list-item><text:p>x</text:p></text:list-item></text:list>'
			}),
			"word/numbering.xml"
		)
		const level = (ilvl: number): string => numbering.split(`<w:lvl w:ilvl="${ilvl}">`)[1]?.split("</w:lvl>")[0] ?? ""

		expect(level(0)).toContain(
			'<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="C00000"/><w:sz w:val="28"/></w:rPr>'
		)
		expect(level(1)).toContain(
			'<w:rPr><w:rFonts w:ascii="OpenSymbol" w:hAnsi="OpenSymbol" w:cs="OpenSymbol"/><w:b/><w:color w:val="C00000"/><w:sz w:val="18"/></w:rPr>'
		)
		expect(level(2)).not.toContain("<w:rPr>")
	})
})
