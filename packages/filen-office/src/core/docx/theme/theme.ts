import type { XmlDocument } from "../../xml/index"
import { Ns } from "../model/namespaces"
import { partReader, type PartReader } from "../model/reader"
import type { LanguageProps, ThemeColorName, ThemeFontRef } from "../props/types"
import { applyColorTransforms, hslToRgb, rgbToHex, type ColorTransform, type ValuedColorTransformKind } from "./color"

// word/theme/theme1.xml (DrawingML, ECMA-376 Part 1 §20.1.6): the colour scheme and the major/minor fonts.

export type SchemeSlot =
	"dk1" | "lt1" | "dk2" | "lt2" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6" | "hlink" | "folHlink"

export const SCHEME_SLOTS: readonly SchemeSlot[] = [
	"dk1",
	"lt1",
	"dk2",
	"lt2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink"
]

export interface ThemeFontSet {
	readonly latin: string
	readonly eastAsia: string
	readonly complex: string
	// a:font by script code ("Jpan", "Hans", "Arab"...).
	readonly scripts: ReadonlyMap<string, string>
}

// ST_WmlColorSchemeIndex values by the attribute names of w:clrSchemeMapping (§17.15.1.20).
export type ColorSchemeMapping = Readonly<Record<string, string>>

export const DEFAULT_COLOR_SCHEME_MAPPING: ColorSchemeMapping = {
	bg1: "light1",
	t1: "dark1",
	bg2: "light2",
	t2: "dark2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hyperlink: "hyperlink",
	followedHyperlink: "followedHyperlink"
}

const INDEX_TO_SLOT: Readonly<Record<string, SchemeSlot>> = {
	dark1: "dk1",
	light1: "lt1",
	dark2: "dk2",
	light2: "lt2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hyperlink: "hlink",
	followedHyperlink: "folHlink"
}

// w:themeColor names that go through the mapping, by mapping attribute.
const MAPPED_NAMES: Readonly<Record<string, string>> = {
	background1: "bg1",
	text1: "t1",
	background2: "bg2",
	text2: "t2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hyperlink: "hyperlink",
	followedHyperlink: "followedHyperlink"
}

// DrawingML scheme colour names (a:schemeClr/@val) to slots; tx/bg go through the mapping like text1.
const SCHEME_CLR_NAMES: Readonly<Record<string, string>> = {
	bg1: "background1",
	tx1: "text1",
	bg2: "background2",
	tx2: "text2",
	dk1: "dark1",
	lt1: "light1",
	dk2: "dark2",
	lt2: "light2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hlink: "hyperlink",
	folHlink: "followedHyperlink"
}

// Script codes of the theme's a:font entries, by primary language subtag (or full tag for Chinese).
const LANGUAGE_SCRIPTS: Readonly<Record<string, string>> = {
	ja: "Jpan",
	ko: "Hang",
	zh: "Hans",
	"zh-cn": "Hans",
	"zh-sg": "Hans",
	"zh-hans": "Hans",
	"zh-tw": "Hant",
	"zh-hk": "Hant",
	"zh-mo": "Hant",
	"zh-hant": "Hant",
	ar: "Arab",
	fa: "Arab",
	ur: "Arab",
	ps: "Arab",
	sd: "Arab",
	ug: "Uigh",
	he: "Hebr",
	yi: "Hebr",
	th: "Thai",
	am: "Ethi",
	ti: "Ethi",
	bn: "Beng",
	as: "Beng",
	gu: "Gujr",
	km: "Khmr",
	kn: "Knda",
	pa: "Guru",
	iu: "Cans",
	chr: "Cher",
	ii: "Yiii",
	bo: "Tibt",
	dz: "Tibt",
	dv: "Thaa",
	hi: "Deva",
	mr: "Deva",
	ne: "Deva",
	sa: "Deva",
	kok: "Deva",
	te: "Telu",
	ta: "Taml",
	syr: "Syrc",
	or: "Orya",
	ml: "Mlym",
	lo: "Laoo",
	si: "Sinh",
	mn: "Mong",
	vi: "Viet",
	ka: "Geor",
	hy: "Armn",
	my: "Mymr"
}

export function scriptForLanguage(tag: string | undefined): string | undefined {
	if (tag === undefined || tag.length === 0) return undefined

	const lower = tag.toLowerCase()

	return LANGUAGE_SCRIPTS[lower] ?? LANGUAGE_SCRIPTS[lower.split("-")[0] ?? ""]
}

const EMPTY_FONTS: ThemeFontSet = { latin: "", eastAsia: "", complex: "", scripts: new Map() }

// System colours by a:sysClr/@val when lastClr is missing.
const SYSTEM_COLORS: Readonly<Record<string, string>> = {
	windowText: "000000",
	window: "FFFFFF",
	btnText: "000000",
	btnFace: "F0F0F0",
	highlight: "0078D7",
	highlightText: "FFFFFF",
	menuText: "000000",
	captionText: "000000",
	grayText: "6D6D6D",
	infoText: "000000",
	infoBk: "FFFFE1"
}

// A few ST_PresetColorVal names; the rest are rare in documents.
const PRESET_COLORS: Readonly<Record<string, string>> = {
	black: "000000",
	white: "FFFFFF",
	red: "FF0000",
	green: "008000",
	lime: "00FF00",
	blue: "0000FF",
	yellow: "FFFF00",
	cyan: "00FFFF",
	aqua: "00FFFF",
	magenta: "FF00FF",
	fuchsia: "FF00FF",
	gray: "808080",
	grey: "808080",
	silver: "C0C0C0",
	maroon: "800000",
	navy: "000080",
	olive: "808000",
	purple: "800080",
	teal: "008080",
	orange: "FFA500"
}

// alphaOff and alphaMod are read by drawingml readColor; a hex colour carries no alpha.
const VALUED_TRANSFORM_KINDS: ReadonlySet<string> = new Set<ValuedColorTransformKind>([
	"tint",
	"shade",
	"lum",
	"lumMod",
	"lumOff",
	"sat",
	"satMod",
	"satOff",
	"hue",
	"hueMod",
	"hueOff",
	"red",
	"redOff",
	"redMod",
	"green",
	"greenOff",
	"greenMod",
	"blue",
	"blueOff",
	"blueMod",
	"alpha"
])

function isValuedTransformKind(kind: string): kind is ValuedColorTransformKind {
	return VALUED_TRANSFORM_KINDS.has(kind)
}

function drawingLocal(r: PartReader, node: number): string {
	return r.group(node) === Ns.A ? r.document.localName(node) : ""
}

function percent(value: string | undefined): number | undefined {
	if (value === undefined) return undefined

	const trimmed = value.trim()
	const number = Number.parseFloat(trimmed)

	if (!Number.isFinite(number)) return undefined

	// Strict writes "50%"; transitional 1000ths of a percent.
	return trimmed.endsWith("%") ? number / 100 : number / 100000
}

// Reads one DrawingML colour choice element (a:srgbClr, a:sysClr, a:schemeClr, a:scrgbClr, a:hslClr,
// a:prstClr) with its transforms. `scheme` resolves a:schemeClr names; undefined when unresolvable.
export function readDrawingColor(document: XmlDocument, node: number, scheme?: (name: string) => string | undefined): string | undefined {
	const r = partReader(document)
	const attribute = (name: string): string | undefined => r.attr(node, Ns.None, name)
	let base: string | undefined

	switch (drawingLocal(r, node)) {
		case "srgbClr": {
			const value = attribute("val")

			base = value !== undefined && /^[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined

			break
		}
		case "sysClr": {
			const last = attribute("lastClr")

			base = last !== undefined && /^[0-9a-fA-F]{6}$/.test(last) ? last.toUpperCase() : SYSTEM_COLORS[attribute("val") ?? ""]

			break
		}
		case "schemeClr":
			base = scheme?.(attribute("val") ?? "")
			break
		case "scrgbClr": {
			const linear = (name: string): number => {
				const value = percent(attribute(name)) ?? 0

				return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
			}

			base = rgbToHex({ r: linear("r"), g: linear("g"), b: linear("b") })

			break
		}
		case "hslClr": {
			const hue = Number.parseFloat(attribute("hue") ?? "0") / 60000

			base = rgbToHex(
				hslToRgb({ h: Number.isFinite(hue) ? hue : 0, s: percent(attribute("sat")) ?? 0, l: percent(attribute("lum")) ?? 0 })
			)

			break
		}
		case "prstClr":
			base = PRESET_COLORS[attribute("val") ?? ""]
			break
	}

	if (base === undefined) return undefined

	const transforms: ColorTransform[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const kind = drawingLocal(r, child)

		if (kind === "comp" || kind === "inv" || kind === "gray" || kind === "gamma" || kind === "invGamma") {
			transforms.push({ kind })
		} else if (isValuedTransformKind(kind)) {
			const raw = r.attr(child, Ns.None, "val")
			// hue and hueOff are in 60000ths of a degree, the rest (hueMod included) in 1000ths of a percent.
			const value = kind === "hue" || kind === "hueOff" ? Number.parseFloat(raw ?? "0") / 60000 : percent(raw)

			if (value !== undefined && Number.isFinite(value)) transforms.push({ kind, value })
		}
	}

	return applyColorTransforms(base, transforms)
}

export class Theme {
	readonly name: string | undefined
	readonly colors: ReadonlyMap<SchemeSlot, string>
	readonly major: ThemeFontSet
	readonly minor: ThemeFontSet
	// A start tag in the theme part could not be read or repeats an attribute: the document is view-only.
	readonly malformed: boolean

	constructor(
		name: string | undefined,
		colors: ReadonlyMap<SchemeSlot, string>,
		major: ThemeFontSet,
		minor: ThemeFontSet,
		malformed: boolean = false
	) {
		this.malformed = malformed
		this.name = name
		this.colors = colors
		this.major = major
		this.minor = minor
	}

	// The scheme colour behind a w:themeColor value, through the document's w:clrSchemeMapping.
	themeColor(name: ThemeColorName, mapping: ColorSchemeMapping = DEFAULT_COLOR_SCHEME_MAPPING): string | undefined {
		const mappedAttribute = MAPPED_NAMES[name]
		const index =
			mappedAttribute === undefined ? name : (mapping[mappedAttribute] ?? DEFAULT_COLOR_SCHEME_MAPPING[mappedAttribute] ?? name)
		const slot = INDEX_TO_SLOT[index]

		return slot === undefined ? undefined : this.colors.get(slot)
	}

	// A DrawingML a:schemeClr name ("accent1", "tx1", "phClr" excluded).
	schemeColor(name: string, mapping: ColorSchemeMapping = DEFAULT_COLOR_SCHEME_MAPPING): string | undefined {
		const themeName = SCHEME_CLR_NAMES[name]

		return themeName === undefined ? undefined : this.themeColor(themeName as ThemeColorName, mapping)
	}

	// The typeface of a theme font reference (§17.15.1.88): with a w:themeFontLang language for the slot
	// (val for Ascii/HAnsi, eastAsia, bidi), the theme's a:font for that language's script; without one, or
	// when the theme has no such script font, the a:latin, a:ea or a:cs typeface.
	font(ref: ThemeFontRef, languages: LanguageProps = {}): string | undefined {
		const set = ref.startsWith("major") ? this.major : this.minor
		const slot = ref.slice(5)
		const language = slot === "EastAsia" ? languages.eastAsia : slot === "Bidi" ? languages.bidi : languages.latin
		const scripted = set.scripts.get(scriptForLanguage(language) ?? "")
		const typeface = scripted ?? (slot === "EastAsia" ? set.eastAsia : slot === "Bidi" ? set.complex : set.latin)

		return typeface === "" ? undefined : typeface
	}
}

function readFontSet(r: PartReader, node: number): ThemeFontSet {
	const document = r.document
	let latin = ""
	let eastAsia = ""
	let complex = ""
	const scripts = new Map<string, string>()

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const typeface = r.attr(child, Ns.None, "typeface") ?? ""

		switch (drawingLocal(r, child)) {
			case "latin":
				latin = typeface
				break
			case "ea":
				eastAsia = typeface
				break
			case "cs":
				complex = typeface
				break
			case "font": {
				const script = r.attr(child, Ns.None, "script")

				if (script !== undefined && typeface !== "") scripts.set(script, typeface)

				break
			}
		}
	}

	return { latin, eastAsia, complex, scripts }
}

function childByLocal(r: PartReader, node: number, local: string): number {
	const document = r.document

	for (let child = node < 0 ? -1 : document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (drawingLocal(r, child) === local) return child
	}

	return -1
}

export function parseTheme(document: XmlDocument): Theme {
	const r = partReader(document)
	const malformed = r.hasMalformed()
	const root = document.documentElement()

	if (root < 0 || drawingLocal(r, root) !== "theme") return new Theme(undefined, new Map(), EMPTY_FONTS, EMPTY_FONTS, malformed)

	const elements = childByLocal(r, root, "themeElements")
	const colorScheme = childByLocal(r, elements, "clrScheme")
	const fontScheme = childByLocal(r, elements, "fontScheme")
	const colors = new Map<SchemeSlot, string>()

	for (const slot of SCHEME_SLOTS) {
		const slotNode = childByLocal(r, colorScheme, slot)
		const colorNode = slotNode < 0 ? -1 : document.firstChildElement(slotNode)
		const color = colorNode < 0 ? undefined : readDrawingColor(document, colorNode)

		if (color !== undefined) colors.set(slot, color)
	}

	const major = childByLocal(r, fontScheme, "majorFont")
	const minor = childByLocal(r, fontScheme, "minorFont")

	return new Theme(
		r.attr(root, Ns.None, "name"),
		colors,
		major < 0 ? EMPTY_FONTS : readFontSet(r, major),
		minor < 0 ? EMPTY_FONTS : readFontSet(r, minor),
		malformed
	)
}
