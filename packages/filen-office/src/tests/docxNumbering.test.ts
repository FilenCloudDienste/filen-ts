import { describe, expect, it } from "vitest"
import { NumberingCounters, englishCardinal, englishOrdinal, formatNumber, parseNumbering } from "../core/docx/numbering/index"
import { PropsStore } from "../core/docx/props/index"
import { parseStyles } from "../core/docx/styles/index"
import { abstractNumbering } from "../core/docx/write/numbering"
import { Names } from "../core/docx/write/markup"
import { stylesXml, wordPart } from "./docxFixtures"

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
