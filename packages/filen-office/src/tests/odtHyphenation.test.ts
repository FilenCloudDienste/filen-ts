import { describe, expect, it } from "vitest"
import { convertText } from "../core/convert/text/index"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { decodeUtf8 } from "../core/xml/index"
import { odtBytes, partText, translated } from "./odtFixtures"

const BODY = '<text:p text:style-name="Hyphenated">Hyphenation</text:p><text:p>Whole</text:p>'

describe("OpenDocument hyphenation translated", () => {
	it("turns on automatic hyphenation for the styles with fo:hyphenate, with their limits", async () => {
		const translation = await translated({
			styles: '<style:style style:name="Hyphenated" style:family="paragraph"><style:paragraph-properties fo:hyphenation-ladder-count="2" loext:hyphenation-zone="0.5in"/><style:text-properties fo:hyphenate="true" fo:hyphenation-remain-char-count="3" fo:hyphenation-push-char-count="4" loext:hyphenation-no-caps="true" loext:hyphenation-word-char-count="7"/></style:style>',
			body: BODY
		})
		const settings = partText(translation, "word/settings.xml")
		const styles = partText(translation, "word/styles.xml")

		expect(settings).toContain(
			'<w:autoHyphenation/><w:consecutiveHyphenLimit w:val="2"/><w:hyphenationZone w:val="720"/><w:doNotHyphenateCaps/>'
		)
		expect(settings).toContain('w:name="hyphenation-chars" w:uri="urn:oasis:names:tc:opendocument:xmlns:style:1.0" w:val="3 4 7"')
		// Every paragraph is suppressed by default (ODF hyphenates nothing unless asked); the style turns it on.
		expect(styles).toMatch(/<w:pPrDefault><w:pPr>.*<w:suppressAutoHyphens\/>/)
		expect(styles).toMatch(/w:styleId="Hyphenated".*<w:suppressAutoHyphens w:val="(?:0|false)"\/>/)
	})

	it("writes no hyphenation settings when no style hyphenates", async () => {
		const settings = partText(await translated({ body: BODY }), "word/settings.xml")

		expect(settings).not.toContain("autoHyphenation")
		expect(settings).not.toContain("hyphenation-chars")
	})

	it("uses LibreOffice's defaults for the limits a document leaves out", async () => {
		const settings = partText(
			await translated({
				styles: '<style:default-style style:family="paragraph"><style:text-properties fo:hyphenate="true"/></style:default-style>',
				body: BODY
			}),
			"word/settings.xml"
		)

		expect(settings).toContain('<w:autoHyphenation/><w:hyphenationZone w:val="0"/>')
		expect(settings).toContain('w:val="2 2 5"')
	})

	// w:compatSetting's w:name is an enumeration (ISO/IEC 29500-1 §17.15.3.4): a .docx written for other readers
	// keeps Word's own hyphenation settings and leaves out the ODF character counts.
	it("leaves the ODF character counts out of a converted .docx and keeps automatic hyphenation", async () => {
		const converted = await convertText(
			odtBytes({
				styles: '<style:default-style style:family="paragraph"><style:text-properties fo:hyphenate="true"/></style:default-style>',
				body: BODY
			}),
			"odt",
			"docx"
		)

		if (!converted.ok) throw new Error("not converted")

		const archive = await ZipArchive.open(bytesSource(converted.bytes))
		const entry = archive.get("word/settings.xml")

		if (entry === undefined) throw new Error("no settings")

		const settings = decodeUtf8(await archive.read(entry))

		expect(settings).toContain("<w:autoHyphenation/>")
		expect(settings).not.toContain("hyphenation-chars")
	})
})
