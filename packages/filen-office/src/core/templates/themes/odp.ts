import { decorationOf, variantOf, type SlideSize } from "./pptx"
import type { FilenTheme, ThemeColorSlot } from "./model"

// A Filen theme as ODF presentation styles (ODF 1.3 Part 3): a master page (§16.9) with its drawing-page style
// (background, §17.5), its presentation styles (title, subtitle, outline1–9, the master's own placeholders; LibreOffice
// names them "<master>-<class>", which readers rely on) and the page layout with the deck's size (§16.5). ODF has no
// theme colours, so the variant's colours are written as they resolve (a dark variant: background dk1, text lt1);
// fonts are the theme's Office names, declared once in office:font-face-decls.

export const NS = {
	office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
	style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
	text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
	draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
	fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
	svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
	presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
	xlink: "http://www.w3.org/1999/xlink"
} as const

export const ODP_ROOT_NS = Object.entries(NS)
	.map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
	.join(" ")

// EMU to centimetres as LibreOffice writes lengths.
export function cm(emu: number): string {
	return `${String(Math.round((emu / 360_000) * 1000) / 1000)}cm`
}

function box(x: number, y: number, w: number, h: number, size: SlideSize): string {
	return `svg:x="${cm(x * size.cx)}" svg:y="${cm(y * size.cy)}" svg:width="${cm(w * size.cx)}" svg:height="${cm(h * size.cy)}"`
}

function escape(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;")
}

// The colour a theme slot takes on this variant's master (the master's colour map applied).
export function odpColor(theme: FilenTheme, variantIndex: number, slot: "bg1" | "tx1" | "bg2" | "tx2" | ThemeColorSlot): string {
	const variant = variantOf(theme, variantIndex)
	const mapped: ThemeColorSlot =
		slot === "bg1"
			? variant.dark
				? "dk1"
				: "lt1"
			: slot === "tx1"
				? variant.dark
					? "lt1"
					: "dk1"
				: slot === "bg2"
					? variant.dark
						? "dk2"
						: "lt2"
					: slot === "tx2"
						? variant.dark
							? "lt2"
							: "dk2"
						: slot

	return `#${variant.colors[mapped].toLowerCase()}`
}

// The theme's two fonts (once when they are the same).
export function themeFaces(theme: FilenTheme): readonly string[] {
	return theme.major === theme.minor ? [theme.major] : [theme.major, theme.minor]
}

// A style:font-face for one of the theme's fonts (§16.23), named by the font.
export function fontFace(face: string): string {
	const generic =
		face === "Courier New" ? "modern" : face === "Cambria" || face === "Georgia" || face === "Times New Roman" ? "roman" : "swiss"
	const pitch = face === "Courier New" ? "fixed" : "variable"

	return `<style:font-face style:name="${escape(face)}" svg:font-family="'${escape(face)}'" style:font-family-generic="${generic}" style:font-pitch="${pitch}"/>`
}

// office:font-face-decls entries for the theme's two fonts (once when they are the same).
export function fontFaces(theme: FilenTheme): string {
	return themeFaces(theme).map(fontFace).join("")
}

// The fractions of the PresentationML master (themes/pptx.ts), so both formats place placeholders alike.
const MARGIN_X = 0.06875
const CONTENT_W = 1 - 2 * MARGIN_X
const TITLE = [MARGIN_X, 0.0532, CONTENT_W, 0.1933] as const
const BODY = [MARGIN_X, 0.2662, CONTENT_W, 0.6345] as const
const FOOTERS = [
	["date-time", MARGIN_X, 0.225, "start"],
	["footer", 0.33125, 0.3375, "center"],
	["page-number", 0.70625, 0.225, "end"]
] as const
export const ODP_TITLE_SLIDE = { title: [0.125, 0.1637, 0.75, 0.3481], subtitle: [0.125, 0.5252, 0.75, 0.2414] } as const
// The content layouts' boxes, as the PresentationML master's Title and Content and Two Content layouts place them.
const HALF_W = (CONTENT_W - 0.0187) / 2
export const ODP_CONTENT_SLIDE = {
	title: TITLE,
	body: BODY,
	left: [MARGIN_X, BODY[1], HALF_W, BODY[3]],
	right: [MARGIN_X + HALF_W + 0.0187, BODY[1], HALF_W, BODY[3]]
} as const

const BODY_SIZES = [28, 24, 20, 18, 18, 18, 18, 18, 18]

// The text insets of the PresentationML placeholders (0.1 in sides, 0.05 in top and bottom, §20.1.2.1.1), written so
// every reader lays the text out alike (LibreOffice's own default differs).
const INSETS = 'fo:padding-top="0.127cm" fo:padding-bottom="0.127cm" fo:padding-left="0.254cm" fo:padding-right="0.254cm"'

function textProperties(font: string, sizePt: number, color: string, language: string | undefined): string {
	const [lang, country] = (language ?? "").split("-")
	const locale =
		lang === undefined || lang === "" ? "" : ` fo:language="${lang}"${country === undefined ? "" : ` fo:country="${country}"`}`

	return (
		`<style:text-properties fo:color="${color}" style:font-name="${escape(font)}" fo:font-size="${String(sizePt)}pt"${locale} ` +
		`style:font-name-asian="${escape(font)}" style:font-size-asian="${String(sizePt)}pt" style:font-name-complex="${escape(font)}" style:font-size-complex="${String(sizePt)}pt"/>`
	)
}

// The bullets of the outline levels (ODF puts a presentation object's list style in its graphic style, §16.30).
function outlineListStyle(name: string, color: string): string {
	return (
		`<text:list-style style:name="${name}">` +
		Array.from(
			{ length: 9 },
			(_, index) =>
				`<text:list-level-style-bullet text:level="${String(index + 1)}" text:bullet-char="•">` +
				`<style:list-level-properties text:space-before="${String(Math.round(index * 1.27 * 1000) / 1000)}cm" text:min-label-width="0.635cm"/>` +
				`<style:text-properties fo:font-family="Arial" style:font-family-generic="swiss" fo:color="${color}" fo:font-size="100%"/></text:list-level-style-bullet>`
		).join("") +
		"</text:list-style>"
	)
}

export interface OdpThemeStyles {
	// Children of office:styles (the master's presentation styles).
	readonly styles: string
	// Children of styles.xml's office:automatic-styles (page layout, drawing-page and graphic styles).
	readonly automatic: string
	// The style:master-page element.
	readonly master: string
}

// Style names: `master` names the master page and prefixes its presentation styles; `prefix` keeps the automatic
// styles of two Filen masters in one file apart.
export function odpThemeStyles(
	theme: FilenTheme,
	variantIndex: number,
	size: SlideSize,
	names: { readonly master: string; readonly displayName?: string; readonly prefix: string },
	language?: string
): OdpThemeStyles {
	const variant = variantOf(theme, variantIndex)
	const m = escape(names.master)
	const p = names.prefix
	const text = odpColor(theme, variantIndex, "tx1")
	const background = odpColor(theme, variantIndex, "bg1")
	const accent = odpColor(theme, variantIndex, "accent1")
	const footerColor = odpColor(theme, variantIndex, "tx2")
	const presentationStyle = (name: string, graphic: string, paragraph: string, textProps: string, parent?: string): string =>
		`<style:style style:name="${m}-${name}" style:family="presentation"${parent === undefined ? "" : ` style:parent-style-name="${m}-${parent}"`}>` +
		`<style:graphic-properties ${graphic}/>${paragraph}${textProps}</style:style>`
	const outline =
		`<style:style style:name="${m}-outline1" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none" ${INSETS}>` +
		`${outlineListStyle(`${p}L`, text)}</style:graphic-properties>` +
		'<style:paragraph-properties fo:margin-top="0.25cm" fo:margin-bottom="0cm" fo:line-height="90%" style:font-independent-line-spacing="true"/>' +
		`${textProperties(theme.minor, BODY_SIZES[0] ?? 28, text, language)}</style:style>` +
		BODY_SIZES.slice(1)
			.map(
				(points, index) =>
					`<style:style style:name="${m}-outline${String(index + 2)}" style:family="presentation" style:parent-style-name="${m}-outline${String(index + 1)}">` +
					`<style:paragraph-properties fo:margin-top="0.127cm" fo:margin-bottom="0cm"/><style:text-properties fo:font-size="${String(points)}pt" style:font-size-asian="${String(points)}pt" style:font-size-complex="${String(points)}pt"/></style:style>`
			)
			.join("")
	const fill =
		variant.background === "gradient"
			? `draw:fill="gradient" draw:fill-gradient-name="${p}g"`
			: `draw:fill="solid" draw:fill-color="${background}"`
	const styles =
		presentationStyle(
			"title",
			`draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="middle" ${INSETS}`,
			'<style:paragraph-properties fo:text-align="start" fo:line-height="90%" style:font-independent-line-spacing="true"/>',
			textProperties(theme.major, 44, text, language)
		) +
		presentationStyle(
			"subtitle",
			`draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="top" ${INSETS}`,
			'<style:paragraph-properties fo:text-align="center" style:font-independent-line-spacing="true"/>',
			textProperties(theme.minor, 24, text, language)
		) +
		outline +
		// LibreOffice draws a master's background from this style; the drawing-page style below is the standard's.
		presentationStyle("background", `draw:stroke="none" ${fill}`, "", "") +
		presentationStyle("backgroundobjects", 'draw:stroke="none" draw:fill="none"', "", "") +
		presentationStyle("notes", 'draw:stroke="none" draw:fill="none"', "", textProperties(theme.minor, 12, "#000000", language))
	const decoration = decorationOf(theme)
	const automatic =
		`<style:page-layout style:name="${p}PM"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" ` +
		`fo:page-width="${cm(size.cx)}" fo:page-height="${cm(size.cy)}" style:print-orientation="${size.cx >= size.cy ? "landscape" : "portrait"}"/></style:page-layout>` +
		`<style:style style:name="${p}dp" style:family="drawing-page"><style:drawing-page-properties draw:background-size="full" ${fill}/></style:style>` +
		(decoration === undefined
			? ""
			: `<style:style style:name="${p}gr" style:family="graphic"><style:graphic-properties ` +
				(decoration.outline === true
					? `draw:stroke="solid" svg:stroke-color="${accent}" svg:stroke-width="0.035cm" draw:fill="none"`
					: `draw:stroke="none" draw:fill="solid" draw:fill-color="${accent}"`) +
				"/></style:style>") +
		FOOTERS.map(
			([kind, , , align]) =>
				`<style:style style:name="${p}${kind}" style:family="presentation" style:parent-style-name="${m}-backgroundobjects">` +
				'<style:graphic-properties draw:textarea-vertical-align="middle"/>' +
				`<style:paragraph-properties fo:text-align="${align}" style:font-independent-line-spacing="true"/>${textProperties(theme.minor, 12, footerColor, language)}</style:style>`
		).join("")
	const decorationShape =
		decoration === undefined
			? ""
			: decoration.geometry === "rtTriangle"
				? `<draw:custom-shape draw:style-name="${p}gr" draw:layer="backgroundobjects" ${box(decoration.box.x, decoration.box.y, decoration.box.w, decoration.box.h, size)}>` +
					'<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:mirror-horizontal="true" draw:type="right-triangle" draw:enhanced-path="M 0 0 L 21600 21600 0 21600 0 0 Z N"/></draw:custom-shape>'
				: `<draw:rect draw:style-name="${p}gr" draw:layer="backgroundobjects" ${box(decoration.box.x, decoration.box.y, decoration.box.w, decoration.box.h, size)}/>`
	const frame = (cls: string, style: string, [x, y, w, h]: readonly number[]): string =>
		`<draw:frame presentation:style-name="${style}" draw:layer="backgroundobjects" ${box(x ?? 0, y ?? 0, w ?? 0, h ?? 0, size)} presentation:class="${cls}" presentation:placeholder="true"><draw:text-box/></draw:frame>`
	const master =
		`<style:master-page style:name="${m}"${names.displayName === undefined ? "" : ` style:display-name="${escape(names.displayName)}"`} style:page-layout-name="${p}PM" draw:style-name="${p}dp">` +
		decorationShape +
		frame("title", `${m}-title`, TITLE) +
		frame("outline", `${m}-outline1`, BODY) +
		FOOTERS.map(([kind, x, w]) => frame(kind, `${p}${kind}`, [x, 0.9268, w, 0.0532])).join("") +
		"</style:master-page>"

	return { styles, automatic, master }
}

// office:styles children shared by every ODP master: the gradient a gradient background names, the default style.
export function odpGradient(theme: FilenTheme, variantIndex: number, prefix: string): string {
	return variantOf(theme, variantIndex).background === "gradient"
		? `<draw:gradient draw:name="${prefix}g" draw:style="linear" draw:angle="0" draw:border="0%" ` +
				`draw:start-color="${odpColor(theme, variantIndex, "bg1")}" draw:end-color="${odpColor(theme, variantIndex, "bg2")}" draw:start-intensity="100%" draw:end-intensity="100%"/>`
		: ""
}

// A gallery theme as one more master page of an existing deck: its styles under `name` (the master page's style:name;
// the automatic styles take "<name>_" and the presentation styles "<name>-" as prefixes, so a name no style of the file
// starts with keeps every one of them apart), shown as the theme's name (themeName), and the whole as a styles
// document of its own (what the editing session reads the new master from).
export interface OdpGalleryMaster {
	// style:font-face elements by the font's name.
	readonly fonts: readonly (readonly [string, string])[]
	// office:styles children: the background gradient (if any) and the presentation styles.
	readonly styles: string
	// office:automatic-styles children: the page layout first, then the master's own styles.
	readonly automatic: string
	readonly pageLayout: string
	readonly master: string
	readonly document: string
}

export function odpGalleryMaster(theme: FilenTheme, variant: number, size: SlideSize, name: string, displayName: string): OdpGalleryMaster {
	const prefix = `${name}_`
	const set = odpThemeStyles(theme, variant, size, { master: name, displayName, prefix })
	const end = set.automatic.indexOf("</style:page-layout>") + "</style:page-layout>".length
	const fonts = themeFaces(theme).map(face => [face, fontFace(face)] as const)
	const styles = odpGradient(theme, variant, prefix) + set.styles

	return {
		fonts,
		styles,
		automatic: set.automatic,
		pageLayout: set.automatic.slice(0, end),
		master: set.master,
		document:
			`<office:document-styles ${ODP_ROOT_NS} office:version="1.3">` +
			`<office:font-face-decls>${fonts.map(([, markup]) => markup).join("")}</office:font-face-decls>` +
			`<office:styles>${styles}</office:styles><office:automatic-styles>${set.automatic}</office:automatic-styles>` +
			`<office:master-styles>${set.master}</office:master-styles></office:document-styles>`
	}
}
