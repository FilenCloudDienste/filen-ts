import { odfPackage } from "./odf"
import { templateLocale } from "./locale"
import { FILEN_THEME, themeName, type FilenTheme } from "./themes/model"
import { WIDESCREEN, type SlideSize } from "./themes/pptx"
import { NS, ODP_CONTENT_SLIDE, ODP_ROOT_NS, ODP_TITLE_SLIDE, cm, fontFaces, odpGradient, odpThemeStyles } from "./themes/odp"
import { zipParts } from "./zip"

// A blank OpenDocument presentation (ODF 1.3 Part 3 §3.6 office:presentation): 33.867 × 19.05 cm (16:9), one title
// page with an empty title and subtitle, on a Filen theme's master page (themes/odp.ts) with Calibri declared as the
// other templates declare it. No meta.xml: nothing about the user is written.

export const ODP_MEDIA_TYPE = "application/vnd.oasis.opendocument.presentation"

export interface BlankOdpOptions {
	// The user's locale (BCP 47): the text's default language.
	readonly locale: string
	readonly theme?: FilenTheme
	readonly variant?: number
	readonly size?: SlideSize
	// Text for the title page's title (a filled deck for render checks); empty by default.
	readonly title?: string
}

// The master page of a deck made from a Filen theme.
export const ODP_MASTER = "Filen"

// The title-slide presentation page layout (LibreOffice's name for it): a title and a subtitle.
const TITLE_LAYOUT = "AL1T0"

// The presentation page layouts (§16.43) the deck offers, named as LibreOffice names its AutoLayouts
// ("AL<n>T<AutoLayout id>"): Title Slide, Title and Content, Two Content, Title Only and Blank, with their placeholders.
const PAGE_LAYOUTS: readonly (readonly [string, readonly (readonly [string, readonly number[]])[]])[] = [
	[
		TITLE_LAYOUT,
		[
			["title", ODP_TITLE_SLIDE.title],
			["subtitle", ODP_TITLE_SLIDE.subtitle]
		]
	],
	[
		"AL2T1",
		[
			["title", ODP_CONTENT_SLIDE.title],
			["outline", ODP_CONTENT_SLIDE.body]
		]
	],
	[
		"AL3T3",
		[
			["title", ODP_CONTENT_SLIDE.title],
			["outline", ODP_CONTENT_SLIDE.left],
			["outline", ODP_CONTENT_SLIDE.right]
		]
	],
	["AL4T19", [["title", ODP_CONTENT_SLIDE.title]]],
	["AL5T20", []]
]

function escape(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
}

function frameBox([x, y, w, h]: readonly number[], size: SlideSize): string {
	return `svg:x="${cm((x ?? 0) * size.cx)}" svg:y="${cm((y ?? 0) * size.cy)}" svg:width="${cm((w ?? 0) * size.cx)}" svg:height="${cm((h ?? 0) * size.cy)}"`
}

const LAYERS =
	"<draw:layer-set>" +
	'<draw:layer draw:name="layout"/><draw:layer draw:name="background"/><draw:layer draw:name="backgroundobjects"/>' +
	'<draw:layer draw:name="controls"/><draw:layer draw:name="measurelines"/></draw:layer-set>'

export function blankOdpParts(options: BlankOdpOptions): ReturnType<typeof odfPackage> {
	const theme = options.theme ?? FILEN_THEME
	const variant = options.variant ?? 0
	const size = options.size ?? WIDESCREEN
	const language = templateLocale(options.locale).tag
	const set = odpThemeStyles(theme, variant, size, { master: ODP_MASTER, displayName: themeName(theme, variant), prefix: "M" }, language)
	const placeholder = (object: string, box: readonly number[]): string =>
		`<presentation:placeholder presentation:object="${object}" ${frameBox(box, size)}/>`
	const layout = PAGE_LAYOUTS.map(
		([name, placeholders]) =>
			`<style:presentation-page-layout style:name="${name}">` +
			placeholders.map(([object, box]) => placeholder(object, box)).join("") +
			"</style:presentation-page-layout>"
	).join("")
	const styles =
		`<office:document-styles ${ODP_ROOT_NS} office:version="1.3">` +
		`<office:font-face-decls>${fontFaces(theme)}</office:font-face-decls>` +
		`<office:styles>${odpGradient(theme, variant, "M")}${set.styles}${layout}</office:styles>` +
		`<office:automatic-styles>${set.automatic}</office:automatic-styles>` +
		`<office:master-styles>${LAYERS}${set.master}</office:master-styles></office:document-styles>`
	const title =
		options.title === undefined || options.title === "" ? "" : `<text:p text:style-name="P1">${escape(options.title)}</text:p>`
	const content =
		`<office:document-content ${ODP_ROOT_NS} office:version="1.3"><office:automatic-styles>` +
		// The title slide's title: centred and larger, bottom-aligned, over the master's title style.
		`<style:style style:name="pr1" style:family="presentation" style:parent-style-name="${ODP_MASTER}-title">` +
		'<style:graphic-properties draw:textarea-vertical-align="bottom"/><style:paragraph-properties fo:text-align="center" style:font-independent-line-spacing="true"/>' +
		'<style:text-properties fo:font-size="60pt" style:font-size-asian="60pt" style:font-size-complex="60pt"/></style:style>' +
		// LibreOffice takes a placeholder's paragraph formatting from its paragraphs only.
		'<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center" style:font-independent-line-spacing="true"/>' +
		'<style:text-properties fo:font-size="60pt" style:font-size-asian="60pt" style:font-size-complex="60pt"/></style:style>' +
		"</office:automatic-styles><office:body><office:presentation>" +
		`<draw:page draw:name="page1" draw:master-page-name="${ODP_MASTER}" presentation:presentation-page-layout-name="${TITLE_LAYOUT}">` +
		`<draw:frame presentation:style-name="pr1" draw:layer="layout" ${frameBox(ODP_TITLE_SLIDE.title, size)} presentation:class="title"${title === "" ? ' presentation:placeholder="true"' : ""}>` +
		`<draw:text-box>${title}</draw:text-box></draw:frame>` +
		`<draw:frame presentation:style-name="${ODP_MASTER}-subtitle" draw:layer="layout" ${frameBox(ODP_TITLE_SLIDE.subtitle, size)} presentation:class="subtitle" presentation:placeholder="true">` +
		"<draw:text-box/></draw:frame>" +
		"</draw:page></office:presentation></office:body></office:document-content>"

	return odfPackage(ODP_MEDIA_TYPE, content, styles)
}

export function blankOdp(options: BlankOdpOptions): Promise<Uint8Array> {
	return zipParts(blankOdpParts(options))
}

export { NS as ODP_NAMESPACES }
