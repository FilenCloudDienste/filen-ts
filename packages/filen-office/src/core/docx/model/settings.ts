import type { XmlDocument } from "../../xml/index"
import { Ns, STRICT_WORDPROCESSINGML } from "./namespaces"
import { partReader, type PartReader } from "./reader"

// w:documentProtection. `edit` is ST_DocProtect: "none", "readOnly", "comments", "trackedChanges", "forms".
export interface DocumentProtection {
	readonly edit: string | undefined
	readonly enforced: boolean
	readonly formatting: boolean
	// A password hash is present (legacy w:hash or w:hashValue).
	readonly hashed: boolean
}

// w:writeProtection: "read-only recommended", optionally with a password to modify.
export interface WriteProtection {
	readonly recommended: boolean
	readonly hashed: boolean
}

export interface CompatSetting {
	readonly name: string | undefined
	readonly uri: string | undefined
	readonly value: string | undefined
}

export interface DocxSettings {
	readonly present: boolean
	// A start tag in the part could not be read (or repeats an attribute): values may have been lost.
	readonly malformed: boolean
	readonly strict: boolean
	readonly trackRevisions: boolean
	// w:doNotTrackMoves: tracked moves are recorded as a deletion and an insertion.
	readonly doNotTrackMoves: boolean
	readonly evenAndOddHeaders: boolean
	readonly mirrorMargins: boolean
	readonly gutterAtTop: boolean
	readonly bookFoldPrinting: boolean
	readonly updateFields: boolean
	readonly autoHyphenation: boolean
	readonly doNotHyphenateCaps: boolean
	readonly displayBackgroundShape: boolean
	// The document asks for spelling errors not to be marked (w:hideSpellingErrors).
	readonly hideSpellingErrors: boolean
	// w:removePersonalInformation: Word strips the user's name from the file properties on save.
	readonly removePersonalInformation: boolean
	// Twips.
	readonly defaultTabStop: number | undefined
	readonly hyphenationZone: number | undefined
	readonly consecutiveHyphenLimit: number | undefined
	// w:compatSetting name="compatibilityMode": 11 (2003), 12 (2007), 14 (2010), 15 (2013+); undefined for
	// files that predate it, which Word treats as 11 or lower.
	readonly compatibilityMode: number | undefined
	readonly compatSettings: readonly CompatSetting[]
	// Legacy compatibility switches turned on in w:compat (local names), e.g. "doNotExpandShiftReturn"; a
	// switch written with w:val="0" (or "false", "off") is off.
	readonly legacyCompat: readonly string[]
	readonly documentProtection: DocumentProtection | undefined
	readonly writeProtection: WriteProtection | undefined
	readonly characterSpacingControl: string | undefined
	readonly themeFontLanguages:
		{ readonly latin: string | undefined; readonly eastAsia: string | undefined; readonly bidi: string | undefined } | undefined
	// w:clrSchemeMapping attributes as written (bg1, t1, accent1... -> ST_WmlColorSchemeIndex values).
	readonly colorSchemeMapping: Readonly<Record<string, string>> | undefined
	// MS-DOCX §2.3.1 compatSetting: off (the default) lets a table style keep its font size and justification
	// against the default paragraph style's 11/12pt and left.
	readonly overrideTableStyleFontSizeAndJustification: boolean
	readonly decimalSymbol: string | undefined
	readonly listSeparator: string | undefined
	// Ids of the notes Word uses as separators (w:footnotePr/w:footnote), as written.
	readonly footnoteSeparators: readonly string[]
	readonly endnoteSeparators: readonly string[]
	// Raw property elements the styles layer reads (-1 when absent).
	readonly footnotePr: number
	readonly endnotePr: number
	// r:id of w:attachedTemplate: recorded, never loaded.
	readonly attachedTemplate: string | undefined
	readonly document: XmlDocument | undefined
}

export const NO_SETTINGS: DocxSettings = {
	present: false,
	malformed: false,
	strict: false,
	trackRevisions: false,
	doNotTrackMoves: false,
	evenAndOddHeaders: false,
	mirrorMargins: false,
	gutterAtTop: false,
	bookFoldPrinting: false,
	updateFields: false,
	autoHyphenation: false,
	doNotHyphenateCaps: false,
	displayBackgroundShape: false,
	hideSpellingErrors: false,
	removePersonalInformation: false,
	defaultTabStop: undefined,
	hyphenationZone: undefined,
	consecutiveHyphenLimit: undefined,
	compatibilityMode: undefined,
	compatSettings: [],
	legacyCompat: [],
	documentProtection: undefined,
	writeProtection: undefined,
	characterSpacingControl: undefined,
	themeFontLanguages: undefined,
	colorSchemeMapping: undefined,
	overrideTableStyleFontSizeAndJustification: false,
	decimalSymbol: undefined,
	listSeparator: undefined,
	footnoteSeparators: [],
	endnoteSeparators: [],
	footnotePr: -1,
	endnotePr: -1,
	attachedTemplate: undefined,
	document: undefined
}

const COLOR_SCHEME_ATTRIBUTES = [
	"bg1",
	"t1",
	"bg2",
	"t2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hyperlink",
	"followedHyperlink"
]

function hashed(reader: PartReader, node: number): boolean {
	return reader.has(node, Ns.W, "hash") || reader.has(node, Ns.W, "hashValue")
}

export function readSettings(document: XmlDocument): DocxSettings {
	const reader = partReader(document)
	const namespaces = reader.namespaces
	const root = document.documentElement()

	if (!reader.is(root, Ns.W, "settings")) return NO_SETTINGS

	const flags = new Map<string, boolean>()
	const compatSettings: CompatSetting[] = []
	const legacyCompat: string[] = []
	const footnoteSeparators: string[] = []
	const endnoteSeparators: string[] = []
	let defaultTabStop: number | undefined
	let hyphenationZone: number | undefined
	let consecutiveHyphenLimit: number | undefined
	let documentProtection: DocumentProtection | undefined
	let writeProtection: WriteProtection | undefined
	let characterSpacingControl: string | undefined
	let themeFontLanguages: DocxSettings["themeFontLanguages"]
	let colorSchemeMapping: Record<string, string> | undefined
	let decimalSymbol: string | undefined
	let listSeparator: string | undefined
	let footnotePr = -1
	let endnotePr = -1
	let attachedTemplate: string | undefined

	const separators = (node: number, local: string, out: string[]): void => {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.is(child, Ns.W, local)) {
				const id = reader.attr(child, Ns.W, "id")

				if (id !== undefined) out.push(id)
			}
		}
	}

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== Ns.W) continue

		const local = document.localName(child)

		switch (local) {
			case "trackRevisions":
			case "doNotTrackMoves":
			case "evenAndOddHeaders":
			case "mirrorMargins":
			case "gutterAtTop":
			case "bookFoldPrinting":
			case "updateFields":
			case "autoHyphenation":
			case "doNotHyphenateCaps":
			case "displayBackgroundShape":
			case "hideSpellingErrors":
			case "removePersonalInformation":
				flags.set(local, reader.onOff(child))

				break
			case "defaultTabStop":
				defaultTabStop = reader.measure(child, Ns.W, "val", 20, Number.NaN)
				if (Number.isNaN(defaultTabStop) || defaultTabStop <= 0) defaultTabStop = undefined

				break
			case "hyphenationZone":
				hyphenationZone = reader.measure(child, Ns.W, "val", 20, Number.NaN)
				if (Number.isNaN(hyphenationZone)) hyphenationZone = undefined

				break
			case "consecutiveHyphenLimit":
				consecutiveHyphenLimit = reader.int(child, Ns.W, "val", Number.NaN)
				if (Number.isNaN(consecutiveHyphenLimit)) consecutiveHyphenLimit = undefined

				break
			case "compat":
				for (let setting = document.firstChildElement(child); setting >= 0; setting = document.nextSiblingElement(setting)) {
					if (reader.is(setting, Ns.W, "compatSetting")) {
						compatSettings.push({
							name: reader.attr(setting, Ns.W, "name"),
							uri: reader.attr(setting, Ns.W, "uri"),
							value: reader.attr(setting, Ns.W, "val")
						})
					} else if (reader.onOff(setting)) {
						legacyCompat.push(document.localName(setting))
					}
				}

				break
			case "documentProtection":
				documentProtection = {
					edit: reader.attr(child, Ns.W, "edit"),
					// Word enforces protection whose w:enforcement is missing (MS-OI29500 §2.1.402 note c).
					enforced: reader.attr(child, Ns.W, "enforcement") === undefined || reader.flag(child, Ns.W, "enforcement"),
					formatting: reader.flag(child, Ns.W, "formatting"),
					hashed: hashed(reader, child)
				}

				break
			case "writeProtection":
				writeProtection = { recommended: reader.flag(child, Ns.W, "recommended"), hashed: hashed(reader, child) }

				break
			case "characterSpacingControl":
				characterSpacingControl = reader.attr(child, Ns.W, "val")

				break
			case "themeFontLang":
				themeFontLanguages = {
					latin: reader.attr(child, Ns.W, "val"),
					eastAsia: reader.attr(child, Ns.W, "eastAsia"),
					bidi: reader.attr(child, Ns.W, "bidi")
				}

				break
			case "clrSchemeMapping":
				colorSchemeMapping = {}

				for (const name of COLOR_SCHEME_ATTRIBUTES) {
					const value = reader.attr(child, Ns.W, name)

					if (value !== undefined) colorSchemeMapping[name] = value
				}

				break
			case "decimalSymbol":
				decimalSymbol = reader.attr(child, Ns.W, "val")

				break
			case "listSeparator":
				listSeparator = reader.attr(child, Ns.W, "val")

				break
			case "footnotePr":
				footnotePr = child
				separators(child, "footnote", footnoteSeparators)

				break
			case "endnotePr":
				endnotePr = child
				separators(child, "endnote", endnoteSeparators)

				break
			case "attachedTemplate":
				attachedTemplate = reader.attr(child, Ns.R, "id")

				break
		}
	}

	const mode = compatSettings.find(setting => setting.name === "compatibilityMode")?.value
	const override = compatSettings.find(setting => setting.name === "overrideTableStyleFontSizeAndJustification")?.value
	const compatibilityMode = mode === undefined || !/^\d+$/.test(mode) ? undefined : Number(mode)

	return {
		present: true,
		malformed: reader.hasMalformed(),
		strict: namespaces.elementUri(root) === STRICT_WORDPROCESSINGML,
		trackRevisions: flags.get("trackRevisions") ?? false,
		doNotTrackMoves: flags.get("doNotTrackMoves") ?? false,
		evenAndOddHeaders: flags.get("evenAndOddHeaders") ?? false,
		mirrorMargins: flags.get("mirrorMargins") ?? false,
		gutterAtTop: flags.get("gutterAtTop") ?? false,
		bookFoldPrinting: flags.get("bookFoldPrinting") ?? false,
		updateFields: flags.get("updateFields") ?? false,
		autoHyphenation: flags.get("autoHyphenation") ?? false,
		doNotHyphenateCaps: flags.get("doNotHyphenateCaps") ?? false,
		displayBackgroundShape: flags.get("displayBackgroundShape") ?? false,
		hideSpellingErrors: flags.get("hideSpellingErrors") ?? false,
		removePersonalInformation: flags.get("removePersonalInformation") ?? false,
		defaultTabStop,
		hyphenationZone,
		consecutiveHyphenLimit,
		compatibilityMode,
		compatSettings,
		legacyCompat,
		documentProtection,
		writeProtection,
		characterSpacingControl,
		themeFontLanguages,
		colorSchemeMapping,
		overrideTableStyleFontSizeAndJustification:
			override !== undefined && override !== "0" && override !== "false" && override !== "off",
		decimalSymbol,
		listSeparator,
		footnoteSeparators,
		endnoteSeparators,
		footnotePr,
		endnotePr,
		attachedTemplate,
		document
	}
}
