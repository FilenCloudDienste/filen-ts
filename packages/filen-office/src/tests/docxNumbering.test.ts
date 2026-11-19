import { describe, expect, it } from "vitest"
import { NumberingCounters, englishCardinal, englishOrdinal, formatNumber, parseNumbering } from "../core/docx/numbering/index"
import { englishLanguage } from "../core/docx/numbering/formats"
import { numberText } from "../core/docx/layout/fields"
import { pageNumberText } from "../core/docx/layout/content"
import { PropsStore } from "../core/docx/props/index"
import { parseStyles } from "../core/docx/styles/index"
import { abstractNumbering } from "../core/docx/write/numbering"
import { Names } from "../core/docx/write/markup"
import { stylesXml, wordPart } from "./docxFixtures"
import { buildDocx } from "./docxSynthetic"
import { pageDigest, pagedEditor, settleAll } from "./pagedFixtures"
import { layOut } from "./layoutFixtures"

function level(ilvl: number, format: string, text: string, extra: string = ""): string {
	return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>${extra}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
}

const NUMBERING = wordPart(
	"numbering",
	'<w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:id="rId1" o:title="" xmlns:o="urn:schemas-microsoft-com:office:office"/></v:shape></w:pict></w:numPicBullet>' +
		'<w:abstractNum w:abstractNumId="0"><w:nsid w:val="1234ABCD"/><w:multiLevelType w:val="multilevel"/>' +
		level(0, "decimal", "%1.") +
		level(1, "lowerLetter", "%1.%2)") +
		level(2, "lowerRoman", "%1.%2.%3", '<w:lvlRestart w:val="0"/>') +
		level(3, "upperRoman", "%4.%1", '<w:lvlRestart w:val="1"/>') +
		level(4, "decimal", "%1.%2.%3.%4.%5", "<w:isLgl/>") +
		"</w:abstractNum>" +
		'<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
		level(0, "bullet", "", '<w:lvlPicBulletId w:val="0"/><w:suff w:val="space"/>') +
		'<w:lvl w:ilvl="1"><w:start w:val="5"/><w:numFmt w:val="custom" w:format="001, 002, 003, ..."/><w:lvlText w:val="%2"/><w:suff w:val="nothing"/><w:lvlJc w:val="right"/></w:lvl>' +
		'<w:lvl w:ilvl="2"><w:numFmt w:val="none"/><w:lvlText w:val="" w:null="1"/></w:lvl>' +
		"</w:abstractNum>" +
		'<w:abstractNum w:abstractNumId="2"><w:numStyleLink w:val="OutlineList"/></w:abstractNum>' +
		'<w:abstractNum w:abstractNumId="3"><w:styleLink w:val="OutlineList"/>' +
		level(0, "upperLetter", "%1:") +
		"</w:abstractNum>" +
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
		'<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num>' +
		'<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>' +
		'<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>' +
		'<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>' +
		'<w:num w:numId="6"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1"><w:lvl w:ilvl="1"><w:start w:val="3"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="[%2]"/></w:lvl></w:lvlOverride></w:num>' +
		'<w:num w:numId="7"><w:abstractNumId w:val="99"/></w:num>'
)

const STYLES = stylesXml(
	'<w:style w:type="numbering" w:styleId="OutlineList"><w:name w:val="Outline List"/><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr></w:style>'
)

function counters(): NumberingCounters {
	const store = new PropsStore()

	return new NumberingCounters(parseNumbering(NUMBERING, store, parseStyles(STYLES, store)))
}

function texts(sequence: readonly (readonly [number, number])[]): string[] {
	const counter = counters()

	return sequence.map(([numId, ilvl]) => counter.next(numId, ilvl)?.text ?? "-")
}

describe("numbering part", () => {
	it("reads abstract definitions, instances, overrides and picture bullets", () => {
		const store = new PropsStore()
		const numbering = parseNumbering(NUMBERING, store, parseStyles(STYLES, store))
		const abstract = numbering.abstracts.get(0)

		expect(abstract?.nsid).toBe("1234ABCD")
		expect(abstract?.multiLevelType).toBe("multilevel")
		expect(abstract?.levels[2]?.restart).toBe(0)
		expect(abstract?.levels[4]?.legal).toBe(true)
		expect(abstract?.levels[0]?.paragraph.indent).toEqual({ start: 720, hanging: 360 })
		expect(numbering.instances.get(2)?.overrides.get(0)).toEqual({ start: 10, level: undefined })
		expect(numbering.pictureBullets.get(0)?.relationshipId).toBe("rId1")
		expect(numbering.level(3, 0)?.level.pictureBulletId).toBe(0)
		expect(numbering.level(3, 1)?.level).toMatchObject({
			start: 5,
			format: "custom",
			customFormat: "001, 002, 003, ...",
			suffix: "nothing",
			alignment: "right"
		})
		expect(numbering.level(3, 2)?.level.text).toBeUndefined()
		expect(numbering.level(1, -3)?.ilvl).toBe(0)
		expect(numbering.level(1, 12)).toBeUndefined()
		expect(numbering.level(7, 0)).toBeUndefined()
		expect(numbering.level(0, 0)).toBeUndefined()
		expect(numbering.has(1)).toBe(true)
		expect(numbering.has(0)).toBe(false)
	})

	it("follows numStyleLink to the levels of the linked definition", () => {
		const store = new PropsStore()
		const numbering = parseNumbering(NUMBERING, store, parseStyles(STYLES, store))
		const linked = numbering.level(4, 0)

		expect(linked?.abstractId).toBe(3)
		expect(linked?.level.format).toBe("upperLetter")
		expect(
			texts([
				[4, 0],
				[5, 0],
				[4, 0]
			])
		).toEqual(["A:", "B:", "C:"])
	})

	it("ignores a numStyleLink cycle", () => {
		const store = new PropsStore()
		const styles = parseStyles(
			stylesXml('<w:style w:type="numbering" w:styleId="Loop"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'),
			store
		)
		const numbering = parseNumbering(
			wordPart(
				"numbering",
				'<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="Loop"/></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
			),
			store,
			styles
		)

		expect(numbering.level(1, 0)).toBeUndefined()
	})
})

describe("new list definitions", () => {
	const indents = (xml: string): string[] => [...xml.matchAll(/<w:lvl w:ilvl="\d">.*?<w:ind ([^/]*)\/>/g)].map(match => match[1] ?? "")

	it("hangs right-aligned roman levels 180 twips like Word's 1. a. i. list", () => {
		const numbered = indents(abstractNumbering(new Names("w", ""), 1, "numbered"))

		expect(numbered).toHaveLength(9)
		expect(numbered[0]).toBe('w:left="720" w:hanging="360"')
		expect(numbered[1]).toBe('w:left="1440" w:hanging="360"')
		expect(numbered[2]).toBe('w:left="2160" w:hanging="180"')
		expect(numbered[5]).toBe('w:left="4320" w:hanging="180"')
		expect(numbered[8]).toBe('w:left="6480" w:hanging="180"')
		expect(indents(abstractNumbering(new Names("w", ""), 1, "bullet")).every(ind => ind.endsWith('w:hanging="360"'))).toBe(true)
	})
})

describe("counters", () => {
	it("counts multilevel lists and restarts deeper levels", () => {
		expect(
			texts([
				[1, 0],
				[1, 1],
				[1, 1],
				[1, 0],
				[1, 1],
				[1, 0]
			])
		).toEqual(["1.", "1.a)", "1.b)", "2.", "2.a)", "3."])
	})

	it("shows the start value for higher levels that never counted", () => {
		expect(texts([[1, 1]])).toEqual(["1.a)"])
	})

	it("honours lvlRestart 0 (never) and lvlRestart n (after level n only)", () => {
		expect(
			texts([
				[1, 0],
				[1, 1],
				[1, 2],
				[1, 2],
				[1, 1],
				[1, 2],
				[1, 0],
				[1, 1],
				[1, 2]
			])
		).toEqual(["1.", "1.a)", "1.a.i", "1.a.ii", "1.b)", "1.b.iii", "2.", "2.a)", "2.a.iv"])

		// Level 4 (index 3) restarts after level 1 only: a level-2 item in between keeps it counting.
		expect(
			texts([
				[1, 0],
				[1, 3],
				[1, 1],
				[1, 3],
				[1, 0],
				[1, 3]
			])
		).toEqual(["1.", "I.1", "1.a)", "II.1", "2.", "I.2"])
	})

	it("shares counters between nums of one abstract definition and applies startOverride on first use", () => {
		expect(
			texts([
				[1, 0],
				[1, 0],
				[2, 0],
				[2, 0],
				[1, 0]
			])
		).toEqual(["1.", "2.", "10.", "11.", "12."])
	})

	it("uses a level override's whole definition for that num only", () => {
		expect(
			texts([
				[6, 0],
				[6, 1],
				[6, 1],
				[1, 1]
			])
		).toEqual(["1.", "[III]", "[IV]", "1.e)"])
	})

	it("writes every number in decimal for a legal level", () => {
		const counter = counters()

		for (const ilvl of [0, 1, 2, 3]) counter.next(1, ilvl)

		expect(counter.next(1, 4)?.text).toBe("1.1.1.1.1")
	})

	it("returns bullets, picture bullets, suffixes and alignment", () => {
		const counter = counters()
		const bullet = counter.next(3, 0)

		expect(bullet).toMatchObject({ text: "", bullet: true, suffix: "space", alignment: "left" })
		expect(bullet?.pictureBullet?.relationshipId).toBe("rId1")
		expect(counter.next(3, 1)).toMatchObject({ text: "005", value: 5, suffix: "nothing", alignment: "right" })
		expect(counter.next(3, 2)?.text).toBe("")
		expect(counter.next(99, 0)).toBeUndefined()
	})

	it("starts over after reset", () => {
		const counter = counters()

		counter.next(1, 0)
		counter.reset()

		expect(counter.next(1, 0)?.text).toBe("1.")
	})
})

describe("number formats", () => {
	it("formats the common Western formats like Word", () => {
		expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(n => formatNumber(n, "upperRoman"))).toEqual([
			"I",
			"IV",
			"IX",
			"XIV",
			"XL",
			"XC",
			"CD",
			"MCMXCIV",
			"MMMCMXCIX"
		])
		expect(formatNumber(12, "lowerRoman")).toBe("xii")
		expect([1, 26, 27, 28, 52, 53].map(n => formatNumber(n, "upperLetter"))).toEqual(["A", "Z", "AA", "BB", "ZZ", "AAA"])
		expect(formatNumber(28, "lowerLetter")).toBe("bb")
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(n => formatNumber(n, "ordinal"))).toEqual([
			"1st",
			"2nd",
			"3rd",
			"4th",
			"11th",
			"12th",
			"13th",
			"21st",
			"22nd",
			"101st",
			"111th"
		])
		expect([3, 10].map(n => formatNumber(n, "decimalZero"))).toEqual(["03", "10"])
		expect(formatNumber(255, "hex")).toBe("FF")
		expect([1, 4, 5, 8].map(n => formatNumber(n, "chicago"))).toEqual(["*", "§", "**", "§§"])
		expect(formatNumber(3, "numberInDash")).toBe("- 3 -")
		expect(formatNumber(7, "custom", "0001, 0002, 0003, ...")).toBe("0007")
		expect(formatNumber(7, "custom", "a, b, c")).toBe("7")
		expect(formatNumber(5, "none")).toBe("")
		expect(formatNumber(5, "somethingNew")).toBe("5")
	})

	it("writes English cardinal and ordinal text", () => {
		expect(formatNumber(1, "cardinalText")).toBe("One")
		expect(formatNumber(21, "cardinalText")).toBe("Twenty-one")
		expect(formatNumber(1, "ordinalText")).toBe("First")
		expect(formatNumber(12, "ordinalText")).toBe("Twelfth")
		expect(formatNumber(20, "ordinalText")).toBe("Twentieth")
		expect(formatNumber(43, "ordinalText")).toBe("Forty-third")
		expect(englishCardinal(1234)).toBe("one thousand two hundred thirty-four")
		expect(englishCardinal(105)).toBe("one hundred five")
		expect(englishCardinal(1_000_000)).toBe("one million")
		expect(englishOrdinal(100)).toBe("one hundredth")
	})

	it("writes the English word and ordinal formats as decimal in another language", () => {
		expect(formatNumber(1, "ordinal", undefined, "de-DE")).toBe("1")
		expect(formatNumber(21, "cardinalText", undefined, "fr-FR")).toBe("21")
		expect(formatNumber(3, "ordinalText", undefined, "de-DE")).toBe("3")
		// English, of any region, and no language: unchanged.
		expect(formatNumber(1, "ordinal", undefined, "en-GB")).toBe("1st")
		expect(formatNumber(21, "cardinalText", undefined, "en-GB")).toBe("Twenty-one")
		expect(formatNumber(3, "ordinalText", undefined, "en-US")).toBe("Third")
		expect(formatNumber(3, "ordinalText")).toBe("Third")
		// Other formats do not depend on it.
		expect(formatNumber(4, "upperRoman", undefined, "de-DE")).toBe("IV")
		expect([undefined, "en", "EN-gb", "de-DE", "eng"].map(englishLanguage)).toEqual([true, true, true, false, false])
	})

	it("numbers a list level whose run is in another language as decimal, an English one in words", () => {
		const store = new PropsStore()
		const lvl = (format: string, lang: string): string =>
			`<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="%1:"/>` +
			`${lang === "" ? "" : `<w:rPr><w:lang w:val="${lang}"/></w:rPr>`}</w:lvl>`
		const numbering = parseNumbering(
			wordPart(
				"numbering",
				`<w:abstractNum w:abstractNumId="0">${lvl("ordinalText", "de-DE")}</w:abstractNum>` +
					`<w:abstractNum w:abstractNumId="1">${lvl("ordinalText", "en-GB")}</w:abstractNum>` +
					`<w:abstractNum w:abstractNumId="2">${lvl("ordinal", "")}</w:abstractNum>` +
					'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
					'<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>'
			),
			store
		)
		const counters = new NumberingCounters(numbering)

		expect([1, 1].map(numId => counters.next(numId, 0)?.text)).toEqual(["1:", "2:"])
		expect([2, 2].map(numId => counters.next(numId, 0)?.text)).toEqual(["First:", "Second:"])
		expect(counters.next(3, 0)?.text).toBe("1st:")
	})

	it("numbers a list in its marker run's language: the paragraph mark's, then the document default", async () => {
		const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
		const docx = (defaults: string, body: string): Uint8Array =>
			buildDocx({
				body,
				relationships: [
					{ id: "rIdN", type: "numbering", target: "numbering.xml" },
					{ id: "rIdS", type: "styles", target: "styles.xml" }
				],
				parts: [
					{
						name: "word/numbering.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
						data:
							`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}">` +
							'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="ordinalText"/><w:lvlText w:val="%1:"/></w:lvl></w:abstractNum>' +
							'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
					},
					{
						name: "word/styles.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
						data:
							`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">` +
							`${defaults === "" ? "" : `<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="${defaults}"/></w:rPr></w:rPrDefault></w:docDefaults>`}</w:styles>`
					}
				]
			})
		const item = (text: string, lang = ""): string =>
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>${lang === "" ? "" : `<w:rPr><w:lang w:val="${lang}"/></w:rPr>`}</w:pPr>` +
			`<w:r><w:t>${text}</w:t></w:r></w:p>`
		const markers = async (bytes: Uint8Array): Promise<string[]> =>
			pageDigest(await layOut(bytes))
				.join("\n")
				.split("\n")
				.flatMap(line => /"([^"]*)"/.exec(line)?.[1]?.split("\\t")[0] ?? [])

		// German by default; the English item's mark is English.
		expect(await markers(docx("de-DE", item("Eins") + item("Two", "en-GB") + item("Drei")))).toEqual(["1:", "Second:", "3:"])
		// English by default (no language anywhere: English); only the French mark's item is in French.
		expect(await markers(docx("", item("One") + item("Deux", "fr-FR") + item("Three")))).toEqual(["First:", "2:", "Third:"])
	})

	it("writes a field's \\* OrdText, CardText and DollarText in its language", () => {
		expect(numberText(3, "ordText", "de-DE")).toBe("3")
		expect(numberText(3, "cardText", "fr-FR")).toBe("3")
		expect(numberText(3, "dollarText", "de-DE")).toBe("3")
		expect(numberText(2, "ordinal", "de-DE")).toBe("2")
		expect(numberText(3, "ordText", "en-GB")).toBe("third")
		expect(numberText(3, "ordText")).toBe("third")
		expect(numberText(2, "ordinal")).toBe("2nd")
	})

	it("updates a \\* OrdText field in its run's language", async () => {
		const field = (lang: string): string => {
			const rPr = lang === "" ? "" : `<w:rPr><w:lang w:val="${lang}"/></w:rPr>`

			return (
				`<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> SEQ Figure \\* OrdText </w:instrText></w:r>` +
				`<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>stale</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
			)
		}
		const { editor } = await pagedEditor(
			buildDocx({ body: `<w:p>${field("de-DE")}</w:p><w:p>${field("")}</w:p><w:p>${field("en-GB")}</w:p>` })
		)
		const results: string[] = []

		await settleAll(editor)
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		editor.session.state.doc.descendants(node => {
			if (node.type.name === "field") results.push(node.attrs["result"] as string)
		})
		expect(results).toEqual(["1", "second", "third"])
	})

	it("lays out and updates a page-number field in its run's language", async () => {
		const field = (instruction: string, lang: string): string => {
			const rPr = `<w:rPr><w:lang w:val="${lang}"/></w:rPr>`

			return (
				`<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>` +
				`<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>stale</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
			)
		}
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					`<w:p>${field("PAGE \\* OrdText", "de-DE")}</w:p><w:p>${field("NUMPAGES \\* CardText", "de-DE")}</w:p>` +
					`<w:p>${field("PAGE \\* OrdText", "en-GB")}</w:p>`
			})
		)
		const results: string[] = []

		await settleAll(editor)

		const shown = (): string[] =>
			pageDigest(editor.layout)
				.join("\n")
				.split("\n")
				.flatMap(line => /"([^"]*)"/.exec(line)?.[1] ?? [])

		expect(shown()).toEqual(["1", "1", "first"])
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		editor.session.state.doc.descendants(node => {
			if (node.type.name === "field") results.push(node.attrs["result"] as string)
		})
		// The update stores what the page shows.
		expect(results).toEqual(["1", "1", "first"])
		await settleAll(editor)
		expect(shown()).toEqual(["1", "1", "first"])
		expect(pageNumberText(1, "ordText", undefined, "de-DE")).toBe("1")
		expect(pageNumberText(1, "ordText", undefined)).toBe("first")
	})

	it("formats East Asian, Hebrew, Arabic and other scripts", () => {
		expect([1, 10, 11, 20, 105, 1000, 12345].map(n => formatNumber(n, "japaneseCounting"))).toEqual([
			"一",
			"十",
			"十一",
			"二十",
			"百〇五",
			"千",
			"一万二千三百四十五"
		])
		expect(formatNumber(10, "chineseCountingThousand")).toBe("一十")
		expect(formatNumber(2024, "ideographDigital")).toBe("二〇二四")
		expect(formatNumber(12, "decimalFullWidth")).toBe("１２")
		expect([1, 20, 21, 50, 51].map(n => formatNumber(n, "decimalEnclosedCircle"))).toEqual(["①", "⑳", "㉑", "㊿", "51"])
		expect(formatNumber(3, "decimalEnclosedParen")).toBe("⑶")
		expect(formatNumber(3, "decimalEnclosedFullstop")).toBe("⒊")
		expect([1, 2, 47].map(n => formatNumber(n, "aiueoFullWidth"))).toEqual(["ア", "イ", "ア"])
		expect(formatNumber(1, "iroha")).toBe("ｲ")
		expect(formatNumber(3, "ganada")).toBe("다")
		expect(formatNumber(12, "koreanDigital")).toBe("일이")
		expect(formatNumber(12, "koreanCounting")).toBe("십이")
		expect([1, 15, 16, 42].map(n => formatNumber(n, "hebrew1"))).toEqual(["א", "טו", "טז", "מב"])
		expect(formatNumber(23, "hebrew2")).toBe("אא")
		expect(formatNumber(2, "arabicAlpha")).toBe("ب")
		expect(formatNumber(3, "arabicAbjad")).toBe("ج")
		expect(formatNumber(42, "hindiNumbers")).toBe("४२")
		expect(formatNumber(42, "thaiNumbers")).toBe("๔๒")
		expect(formatNumber(29, "russianUpper")).toBe("АА")
	})
})

describe("hostile numbering", () => {
	it("clamps start values, falls back to decimal past readable sizes and never throws", () => {
		const store = new PropsStore()
		const lvl = (ilvl: number, format: string, start: string): string =>
			`<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="%${ilvl + 1}."/></w:lvl>`
		const numbering = parseNumbering(
			wordPart(
				"numbering",
				`<w:abstractNum w:abstractNumId="0">${lvl(0, "upperRoman", "4000000")}${lvl(1, "chicago", "99999999999")}${lvl(2, "upperLetter", "99999999999")}${lvl(3, "lowerLetter", "2147483647")}</w:abstractNum>` +
					'<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="-99999999999"/></w:lvlOverride></w:num>'
			),
			store
		)
		const counters = new NumberingCounters(numbering)

		expect(numbering.level(1, 1)?.start).toBe(2147483647)
		expect(numbering.level(1, 0)?.start).toBe(-2147483648)
		expect(counters.next(1, 0)?.text).toBe("-2147483648.")
		expect(counters.next(1, 1)?.text).toBe("2147483647.")
		expect(counters.next(1, 2)?.text).toBe("2147483647.")
		expect(counters.next(1, 3)?.text).toBe("2147483647.")
		// Counting on past int32 does not wrap.
		expect(counters.next(1, 3)?.value).toBe(2147483648)
	})

	it("caps formats at their readable range", () => {
		expect(formatNumber(3999, "upperRoman")).toBe("MMMCMXCIX")
		expect(formatNumber(4000, "upperRoman")).toBe("4000")
		expect(formatNumber(780, "upperLetter")).toBe("Z".repeat(30))
		expect(formatNumber(781, "upperLetter")).toBe("781")
		expect(formatNumber(121, "chicago")).toBe("121")
		expect(formatNumber(1e9, "lowerLetter")).toBe("1000000000")
	})
})
