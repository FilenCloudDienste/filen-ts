import { FILEN_THEME, type FilenTheme } from "./themes/model"
import {
	CONTENT_TYPE,
	PACKAGE_RELATIONSHIPS,
	RELATIONSHIP,
	WIDESCREEN,
	designSet,
	relationshipsXml,
	slideXml,
	type SlideSize
} from "./themes/pptx"
import { templateLocale } from "./locale"
import { zipParts, type TemplatePart } from "./zip"

// A blank PresentationML deck (ECMA-376 Part 1 §13.3.6, §19.2.1.26): 16:9 at 13.333 × 7.5 in, one title slide with
// an empty title and subtitle, on a Filen theme (the plain white one by default) with its master and eleven layouts.
// No properties or author: nothing about the user is written.

export interface BlankPptxOptions {
	// The user's locale (BCP 47): the language of the slide's text.
	readonly locale?: string
	readonly theme?: FilenTheme
	readonly variant?: number
	readonly size?: SlideSize
	// Text for the title slide's title (a filled deck for render checks); empty by default.
	readonly title?: string
}

// p:sldMasterId@id values start at 2^31 (§19.2.1.34).
const FIRST_MASTER_ID = 2_147_483_648

export function blankPptxParts(options: BlankPptxOptions = {}): TemplatePart[] {
	const size = options.size ?? WIDESCREEN
	const set = designSet(
		options.theme ?? FILEN_THEME,
		options.variant ?? 0,
		size,
		{
			theme: "ppt/theme/theme1.xml",
			master: "ppt/slideMasters/slideMaster1.xml",
			layouts: Array.from({ length: 11 }, (_, index) => `ppt/slideLayouts/slideLayout${String(index + 1)}.xml`)
		},
		FIRST_MASTER_ID
	)
	const overrides = [
		["/ppt/presentation.xml", CONTENT_TYPE.presentation],
		[`/${set.master.name}`, CONTENT_TYPE.master],
		...set.layouts.map(layout => [`/${layout.name}`, CONTENT_TYPE.layout]),
		["/ppt/slides/slide1.xml", CONTENT_TYPE.slide],
		[`/${set.theme.name}`, CONTENT_TYPE.theme]
	]
	const contentTypes =
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		overrides.map(([name, type]) => `<Override PartName="${name ?? ""}" ContentType="${type ?? ""}"/>`).join("") +
		"</Types>"
	const presentation =
		`<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${RELATIONSHIP}" ` +
		'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">' +
		`<p:sldMasterIdLst><p:sldMasterId id="${String(FIRST_MASTER_ID)}" r:id="rId1"/></p:sldMasterIdLst>` +
		'<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
		`<p:sldSz cx="${String(size.cx)}" cy="${String(size.cy)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

	return [
		["[Content_Types].xml", contentTypes],
		[
			"_rels/.rels",
			`<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${RELATIONSHIP}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
		],
		["ppt/presentation.xml", presentation],
		[
			"ppt/_rels/presentation.xml.rels",
			relationshipsXml([
				{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
				{ id: "rId2", type: "slide", target: "slides/slide1.xml" },
				{ id: "rId3", type: "theme", target: "theme/theme1.xml" }
			])
		],
		[set.master.name, set.master.markup],
		["ppt/slideMasters/_rels/slideMaster1.xml.rels", set.master.rels ?? ""],
		...set.layouts.flatMap((layout, index): TemplatePart[] => [
			[layout.name, layout.markup],
			[`ppt/slideLayouts/_rels/slideLayout${String(index + 1)}.xml.rels`, layout.rels ?? ""]
		]),
		[
			"ppt/slides/slide1.xml",
			slideXml("title", options.title, options.locale === undefined ? undefined : templateLocale(options.locale).tag)
		],
		[
			"ppt/slides/_rels/slide1.xml.rels",
			relationshipsXml([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }])
		],
		[set.theme.name, set.theme.markup]
	]
}

export function blankPptx(options: BlankPptxOptions = {}): Promise<Uint8Array> {
	return zipParts(blankPptxParts(options))
}
