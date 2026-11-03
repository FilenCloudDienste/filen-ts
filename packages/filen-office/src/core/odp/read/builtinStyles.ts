import { readElement, type OdfElement, type OdfProperties } from "../../odf/index"
import { Namespaces, encodeUtf8, parseXml } from "../../xml/index"

// LibreOffice 7.5's own presentation styles of a master page that defines none: what it gives that master's title,
// subtitle, outline and notes objects, as it writes them when it saves such a file (measured on lo__tdf96708, whose
// master "Master1" names no styles: "<master>-title" 44 pt centred, "-subtitle" 32 pt centred, "-outline1" 32 pt with
// its default bullets, "-outline2".."-outline9" 28/24/20/20… pt, "-notes" 20 pt, all in Liberation Sans in the
// window's text colour). Only the properties the reader maps are kept, without the fill and line those styles write:
// LibreOffice draws such an object with the standard graphic style's (odpClassObjectStyles, measured). They are read, never written: a save leaves
// the file's master without styles, as LibreOffice reads it.

const TEXT = (size: number) =>
	`<style:text-properties fo:font-family="'Liberation Sans'" style:font-family-generic="roman" style:font-pitch="variable" style:use-window-font-color="true" fo:font-size="${String(size)}pt" fo:font-style="normal" fo:font-weight="normal"/>`

const BULLETS: readonly (readonly [string, string, string, string])[] = [
	["●", "0.3cm", "0.9cm", "45%"],
	["–", "1.5cm", "0.9cm", "75%"],
	["●", "2.8cm", "0.8cm", "45%"],
	["–", "4.2cm", "0.6cm", "75%"],
	["●", "5.4cm", "0.6cm", "45%"],
	["●", "6.6cm", "0.6cm", "45%"],
	["●", "7.8cm", "0.6cm", "45%"],
	["●", "9cm", "0.6cm", "45%"],
	["●", "10.2cm", "0.6cm", "45%"],
	["●", "11.4cm", "0.6cm", "45%"]
]

const OUTLINE_LIST =
	"<text:list-style>" +
	BULLETS.map(
		([char, before, label, size], at) =>
			`<text:list-level-style-bullet text:level="${String(at + 1)}" text:bullet-char="${char}"><style:list-level-properties text:space-before="${before}" text:min-label-width="${label}"/><style:text-properties fo:font-family="OpenSymbol" style:use-window-font-color="true" fo:font-size="${size}"/></text:list-level-style-bullet>`
	).join("") +
	"</text:list-style>"

// The outline levels' own sizes and spacing above (outline1 the base the others derive from).
const OUTLINE: readonly (readonly [number, string])[] = [
	[32, "0.5cm"],
	[28, "0.4cm"],
	[24, "0.3cm"],
	[20, "0.2cm"],
	[20, "0.1cm"],
	[20, "0.1cm"],
	[20, "0.1cm"],
	[20, "0.1cm"],
	[20, "0.1cm"]
]

const MARKUP: Readonly<Record<string, string>> = {
	title:
		'<style:graphic-properties draw:textarea-vertical-align="middle"/>' +
		'<style:paragraph-properties fo:text-align="center"/>' +
		TEXT(44),
	subtitle:
		'<style:graphic-properties draw:textarea-vertical-align="middle"/>' +
		'<style:paragraph-properties fo:margin-left="0cm" fo:margin-right="0cm" fo:text-align="center" fo:text-indent="0cm"/>' +
		TEXT(32),
	notes:
		"<style:graphic-properties/>" +
		'<style:paragraph-properties fo:margin-left="0.6cm" fo:margin-right="0cm" fo:text-indent="-0.6cm"/>' +
		TEXT(20),
	...Object.fromEntries(
		OUTLINE.map(([size, before], at) => [
			`outline${String(at + 1)}`,
			'<style:graphic-properties draw:auto-grow-height="false" draw:fit-to-size="false" style:shrink-to-fit="true">' +
				OUTLINE_LIST +
				"</style:graphic-properties>" +
				`<style:paragraph-properties fo:margin-top="${before}" fo:margin-bottom="0cm"/>` +
				TEXT(size)
		])
	)
}

const SCOPE =
	'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'

let parsed: Map<string, ReadonlyMap<string, OdfProperties>> | undefined

// The built-in style of a class suffix ("title", "subtitle", "outline1".."outline9", "notes"), by property kind.
export function builtinPresentationStyle(suffix: string): ReadonlyMap<string, OdfProperties> | undefined {
	parsed ??= new Map(
		Object.entries(MARKUP).map(([name, markup]) => {
			const document = parseXml(encodeUtf8(`<style:style ${SCOPE}>${markup}</style:style>`))
			const element = readElement(document, new Namespaces(document), document.documentElement())

			return [name, propertiesOf(element)]
		})
	)

	return parsed.get(suffix)
}

function propertiesOf(element: OdfElement): ReadonlyMap<string, OdfProperties> {
	const out = new Map<string, OdfProperties>()

	for (const child of element.children) {
		const match = /^style:([\w-]+)-properties$/u.exec(child.name)

		if (match?.[1] !== undefined) out.set(match[1], { attributes: child.attributes, children: child.children })
	}

	return out
}

// The class suffixes a master's built-in styles cover.
export const BUILTIN_SUFFIX = /^(title|subtitle|notes|outline[1-9])$/u
