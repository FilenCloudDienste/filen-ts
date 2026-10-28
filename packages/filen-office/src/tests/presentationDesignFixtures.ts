import { blankOdpParts } from "../core/templates/odp"
import { blankPptxParts } from "../core/templates/pptx"
import { filenTheme } from "../core/templates/themes/catalog"
import { odpThemeStyles } from "../core/templates/themes/odp"
import { LAYOUT_TYPES, WIDESCREEN, relationshipsXml, slideXml, type FilenLayoutType } from "../core/templates/themes/pptx"
import { zipParts, type TemplatePart } from "../core/templates/zip"
import type { FilenTheme } from "../core/templates/themes/model"

// Decks for the design family's tests: a Filen template with more slides, each on a layout of the template's master
// (its title written in the first placeholder).

const SLIDE_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"

export function designDeckParts(
	slides: readonly FilenLayoutType[],
	options: { readonly theme?: FilenTheme; readonly variant?: number } = {}
): TemplatePart[] {
	const parts = blankPptxParts({ ...options, title: "Slide 1" })
	const extra = slides.slice(1)
	const out: TemplatePart[] = []

	for (const part of parts) {
		const [name, markup] = part

		if (name === "[Content_Types].xml") {
			const overrides = extra
				.map((_, index) => `<Override PartName="/ppt/slides/slide${String(index + 2)}.xml" ContentType="${SLIDE_TYPE}"/>`)
				.join("")

			out.push([name, markup.replace("</Types>", `${overrides}</Types>`)])
		} else if (name === "ppt/presentation.xml") {
			const ids = extra.map((_, index) => `<p:sldId id="${String(257 + index)}" r:id="rIdS${String(index + 2)}"/>`).join("")

			out.push([name, markup.replace("</p:sldIdLst>", `${ids}</p:sldIdLst>`)])
		} else if (name === "ppt/_rels/presentation.xml.rels") {
			const rels = extra
				.map(
					(_, index) =>
						`<Relationship Id="rIdS${String(index + 2)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${String(index + 2)}.xml"/>`
				)
				.join("")

			out.push([name, markup.replace("</Relationships>", `${rels}</Relationships>`)])
		} else if (name === "ppt/slides/slide1.xml" && slides[0] !== undefined && slides[0] !== "title") {
			out.push([name, slideXml(slides[0], "Slide 1")])
		} else if (name === "ppt/slides/_rels/slide1.xml.rels" && slides[0] !== undefined) {
			out.push([
				name,
				relationshipsXml([
					{
						id: "rId1",
						type: "slideLayout",
						target: `../slideLayouts/slideLayout${String(LAYOUT_TYPES.indexOf(slides[0]) + 1)}.xml`
					}
				])
			])
		} else {
			out.push(part)
		}
	}

	extra.forEach((type, index) => {
		const n = index + 2

		out.push([`ppt/slides/slide${String(n)}.xml`, slideXml(type, `Slide ${String(n)}`)])
		out.push([
			`ppt/slides/_rels/slide${String(n)}.xml.rels`,
			relationshipsXml([
				{
					id: "rId1",
					type: "slideLayout",
					target: `../slideLayouts/slideLayout${String(LAYOUT_TYPES.indexOf(type) + 1)}.xml`
				}
			])
		])
	})

	return out
}

export function designDeck(
	slides: readonly FilenLayoutType[],
	options: { readonly theme?: FilenTheme; readonly variant?: number } = {}
): Promise<Uint8Array> {
	return zipParts(designDeckParts(slides, options))
}

// An ODP with two master pages ("Filen" and "Slate", from two Filen themes) and `pages` pages on the first, each
// with a title; `content` changes content.xml after the pages are made.
export function designOdp(pages: number, content: (markup: string) => string = markup => markup): Promise<Uint8Array> {
	const slate = filenTheme("slate")

	if (slate === undefined) throw new Error("no slate")

	const second = odpThemeStyles(slate, 0, WIDESCREEN, {
		master: "Slate",
		prefix: "S"
	})

	return zipParts(
		blankOdpParts({ locale: "en-US", title: "Page 1" }).map(([name, markup, stored]): TemplatePart => {
			if (stored !== undefined) return [name, markup, stored]
			if (name === "styles.xml")
				return [
					name,
					markup
						.replace("</office:styles>", `${second.styles}</office:styles>`)
						.replace("</office:automatic-styles>", `${second.automatic}</office:automatic-styles>`)
						.replace("</office:master-styles>", `${second.master}</office:master-styles>`)
				]
			if (name === "content.xml") {
				const page = /<draw:page .*<\/draw:page>/u.exec(markup)?.[0] ?? ""
				const more = Array.from({ length: pages - 1 }, (_, index) =>
					page.replace('draw:name="page1"', `draw:name="page${String(index + 2)}"`).replace("Page 1", `Page ${String(index + 2)}`)
				).join("")

				return [name, content(markup.replace("</office:presentation>", `${more}</office:presentation>`))]
			}

			return [name, markup]
		})
	)
}
