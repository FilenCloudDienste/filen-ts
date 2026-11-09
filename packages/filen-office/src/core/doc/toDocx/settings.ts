import type { DocModel } from "../model"
import { STORY_NAMESPACES, attr, clamp, val } from "./xml"

// Dop (§2.7) → settings.xml (ECMA-376 Part 1 §17.15.1). Word 97–2003 layout: compatibilityMode 11 plus the
// compatibility options the Dop's Copts60/Copts80/Copts set (§2.7.3/§2.7.4/§2.7.13, each named after the
// ECMA-376 compat element it specifies).

// [bit in Copts (copts60 bits 0–15, copts80 16–31, Copts 32–64), element, the element means the opposite].
const COPTS: readonly (readonly [number, string, boolean])[] = [
	[0, "noTabHangInd", false],
	[1, "noSpaceRaiseLower", false],
	[2, "suppressSpBfAfterPgBrk", false],
	[3, "wrapTrailSpaces", false],
	[4, "printColBlack", false],
	[5, "noColumnBalance", false],
	[6, "convMailMergeEsc", false],
	[7, "suppressTopSpacing", false],
	[8, "useSingleBorderforContiguousCells", false],
	[10, "showBreaksInFrames", false],
	[11, "swapBordersFacingPages", false],
	[12, "doNotLeaveBackslashAlone", true],
	[13, "doNotExpandShiftReturn", true],
	[14, "ulTrailSpace", true],
	[15, "balanceSingleByteDoubleByteWidth", true],
	[16, "suppressSpacingAtTopOfPage", false],
	[17, "spacingInWholePoints", false],
	[18, "printBodyTextBeforeHeader", false],
	[19, "noLeading", false],
	[20, "spaceForUL", true],
	[21, "mwSmallCaps", false],
	[22, "suppressTopSpacingWP", false],
	[23, "truncateFontHeightsLikeWP6", false],
	[24, "subFontBySize", false],
	[25, "lineWrapLikeWord6", false],
	[26, "doNotSuppressParagraphBorders", false],
	[27, "noExtraLineSpacing", false],
	[28, "suppressBottomSpacing", false],
	[29, "wpSpaceWidth", false],
	[30, "wpJustification", false],
	[31, "usePrinterMetrics", false],
	[32, "shapeLayoutLikeWW8", false],
	[33, "footnoteLayoutLikeWW8", false],
	[34, "doNotUseHTMLParagraphAutoSpacing", false],
	[35, "adjustLineHeightInTable", true],
	[36, "forgetLastTabAlignment", false],
	[37, "autoSpaceLikeWord95", false],
	[38, "alignTablesRowByRow", false],
	[39, "layoutRawTableWidth", false],
	[40, "layoutTableRowsApart", false],
	[41, "useWord97LineBreakRules", false],
	[42, "doNotBreakWrappedTables", false],
	[43, "doNotSnapToGridInCell", false],
	[44, "selectFldWithFirstOrLastChar", false],
	[45, "applyBreakingRules", false],
	[46, "doNotWrapTextWithPunct", false],
	[47, "doNotUseEastAsianBreakRules", false],
	[48, "useWord2002TableStyleRules", false],
	[49, "growAutofit", false],
	[50, "useNormalStyleForList", false],
	[51, "doNotUseIndentAsNumberingTabStop", false],
	[52, "useAltKinsokuLineBreakRules", false],
	[53, "allowSpaceOfSameStyleInTable", false],
	[54, "doNotSuppressIndentation", false],
	[55, "doNotAutofitConstrainedTables", false],
	[56, "autofitToFirstFixedWidthCell", false],
	[57, "underlineTabInNumList", false],
	[58, "displayHangulFixedWidth", false],
	[59, "splitPgBreakAndParaMark", false],
	[60, "doNotVertAlignCellWithSp", false],
	[61, "doNotBreakConstrainedForcedTable", false],
	[62, "doNotVertAlignInTxbx", false],
	[63, "useAnsiKerningPairs", false],
	[64, "cachedColBalance", false]
]

// CT_Compat's sequence (§17.15.3, Part 4 §14.8.3).
const COMPAT_ORDER: readonly string[] = [
	"useSingleBorderforContiguousCells",
	"wpJustification",
	"noTabHangInd",
	"noLeading",
	"spaceForUL",
	"noColumnBalance",
	"balanceSingleByteDoubleByteWidth",
	"noExtraLineSpacing",
	"doNotLeaveBackslashAlone",
	"ulTrailSpace",
	"doNotExpandShiftReturn",
	"spacingInWholePoints",
	"lineWrapLikeWord6",
	"printBodyTextBeforeHeader",
	"printColBlack",
	"wpSpaceWidth",
	"showBreaksInFrames",
	"subFontBySize",
	"suppressBottomSpacing",
	"suppressTopSpacing",
	"suppressSpacingAtTopOfPage",
	"suppressTopSpacingWP",
	"suppressSpBfAfterPgBrk",
	"swapBordersFacingPages",
	"convMailMergeEsc",
	"truncateFontHeightsLikeWP6",
	"mwSmallCaps",
	"usePrinterMetrics",
	"doNotSuppressParagraphBorders",
	"wrapTrailSpaces",
	"footnoteLayoutLikeWW8",
	"shapeLayoutLikeWW8",
	"alignTablesRowByRow",
	"forgetLastTabAlignment",
	"adjustLineHeightInTable",
	"autoSpaceLikeWord95",
	"noSpaceRaiseLower",
	"doNotUseHTMLParagraphAutoSpacing",
	"layoutRawTableWidth",
	"layoutTableRowsApart",
	"useWord97LineBreakRules",
	"doNotBreakWrappedTables",
	"doNotSnapToGridInCell",
	"selectFldWithFirstOrLastChar",
	"applyBreakingRules",
	"doNotWrapTextWithPunct",
	"doNotUseEastAsianBreakRules",
	"useWord2002TableStyleRules",
	"growAutofit",
	"useFELayout",
	"useNormalStyleForList",
	"doNotUseIndentAsNumberingTabStop",
	"useAltKinsokuLineBreakRules",
	"allowSpaceOfSameStyleInTable",
	"doNotSuppressIndentation",
	"doNotAutofitConstrainedTables",
	"autofitToFirstFixedWidthCell",
	"underlineTabInNumList",
	"displayHangulFixedWidth",
	"splitPgBreakAndParaMark",
	"doNotVertAlignCellWithSp",
	"doNotBreakConstrainedForcedTable",
	"doNotVertAlignInTxbx",
	"useAnsiKerningPairs",
	"cachedColBalance"
]

// Dop offsets (§2.7.2 DopBase, §2.7.3 Dop95, §2.7.5 Dop2000).
const COPTS60 = 8
const COPTS80 = 84
const DOP97_SIZE = 500
const DOP2000_COPTS = DOP97_SIZE + 8
const COPTS_SIZE = 32

// The 32-byte Copts the Dop specifies: Dop2000's when present, else copts80 (Dop95) or copts60 (DopBase) alone.
export function dopCopts(dop: Uint8Array): Uint8Array {
	const copts = new Uint8Array(COPTS_SIZE)

	if (dop.length >= DOP2000_COPTS + COPTS_SIZE) copts.set(dop.subarray(DOP2000_COPTS, DOP2000_COPTS + COPTS_SIZE))
	else if (dop.length >= COPTS80 + 4) copts.set(dop.subarray(COPTS80, COPTS80 + 4))
	else if (dop.length >= COPTS60 + 2) copts.set(dop.subarray(COPTS60, COPTS60 + 2))

	return copts
}

export function compatElements(dop: Uint8Array): string[] {
	const copts = dopCopts(dop)
	const on = new Set<string>()

	for (const [bit, name, inverted] of COPTS) {
		const set = ((copts[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0

		if (set !== inverted) on.add(name)
	}

	return COMPAT_ORDER.filter(name => on.has(name))
}

function u16(data: Uint8Array, at: number): number {
	return (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8)
}

function u32(data: Uint8Array, at: number): number {
	return (u16(data, at) | (u16(data, at + 2) << 16)) >>> 0
}

function bit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0
}

// The transitional w:documentProtection hash (w:hash, w:salt, base64; SHA-1) of the document's protection key.
export interface ProtectionKeyHash {
	readonly hash: string
	readonly salt: string
	readonly spinCount: number
}

const DOP_FLAGS = 4
const DOP_KEY = 78
// Dop2003 (§2.7.11) follows Dop2002 (594 bytes) and is 22 bytes long.
const DOP2003 = 594
const DOP2003_LENGTH = 22

export type DopProtectionEdit = "forms" | "comments" | "trackedChanges" | "readOnly"

// iDocProtCur (§2.7.11): 0 revision marking, 1 annotations, 2 forms, 3 read-only; 7 none.
const CURRENT_PROTECTION: readonly (DopProtectionEdit | undefined)[] = ["trackedChanges", "comments", "forms", "readOnly"]

// The editing restriction the Dop enforces, and its password key (lKeyProtDoc, the 32-bit legacy verifier; 0 for
// none). Word 2003 and later state it in Dop2003: fEnforceDocProt with iDocProtCur; otherwise DopBase fProtEnabled,
// fLockAtn and fLockRev do, fLockAtn meaning read-only when Dop2003.fTreatLockAtnAsReadOnly is set (§2.7.2).
export function dopProtection(dop: Uint8Array): { readonly edit: DopProtectionEdit; readonly key: number } | undefined {
	if (dop.length < DOP_KEY + 4) return undefined

	const flags = u32(dop, DOP_FLAGS)
	const dop2003 = dop.length >= DOP2003 + DOP2003_LENGTH
	const enforced = dop2003 ? (dop[DOP2003 + 4] ?? 0) : 0
	let edit: DopProtectionEdit | undefined

	if (bit(enforced, 3)) edit = CURRENT_PROTECTION[(enforced >> 4) & 7]
	else if (bit(flags, 25)) edit = "forms"
	else if (bit(flags, 20)) edit = dop2003 && bit(dop[DOP2003] ?? 0, 0) ? "readOnly" : "comments"
	else if (bit(flags, 30)) edit = "trackedChanges"

	return edit === undefined ? undefined : { edit, key: u32(dop, DOP_KEY) }
}

function protectionKeyAttributes(hash: ProtectionKeyHash): string {
	return (
		' w:cryptProviderType="rsaFull" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="4"' +
		`${attr("w:cryptSpinCount", hash.spinCount)}${attr("w:hash", hash.hash)}${attr("w:salt", hash.salt)}`
	)
}

const PROTECTION_OPEN = "<w:documentProtection "

// A settings part settingsPart wrote without the protection hash, with it: the hash goes into its one
// w:documentProtection element; a part without one comes back as it was.
export function withProtectionHash(settings: string, hash: ProtectionKeyHash): string {
	const open = settings.indexOf(PROTECTION_OPEN)
	const close = open < 0 ? -1 : settings.indexOf("/>", open)

	return close < 0 ? settings : settings.slice(0, close) + protectionKeyAttributes(hash) + settings.slice(close)
}

export interface NoteSettings {
	// Ids of the separator notes in footnotes.xml / endnotes.xml, when those parts are written.
	readonly footnotes: boolean
	readonly endnotes: boolean
}

export function settingsPart(model: DocModel, notes: NoteSettings, protectionHash?: ProtectionKeyHash): string {
	const dop = model.dop
	const flags = u32(dop, 4)
	const out: string[] = [`<w:settings ${STORY_NAMESPACES}>`]

	if (model.fib.fReadOnlyRecommended) out.push('<w:writeProtection w:recommended="1"/>')

	if (dop.length >= 84) {
		const view = u16(dop, 82)
		const percent = (view >> 3) & 0x1ff
		const zoom = (view >> 12) & 3

		if (percent >= 10 && percent <= 500)
			out.push(
				`<w:zoom${zoom === 0 ? "" : attr("w:val", ["none", "fullPage", "bestFit", "textFit"][zoom] ?? "none")}${attr("w:percent", percent)}/>`
			)
	}

	const formFlags = dop.length >= 56 ? u16(dop, 54) : 0

	if (bit(formFlags, 10)) out.push("<w:printFormsData/>")
	if (bit(flags, 21)) out.push("<w:mirrorMargins/>")
	if (dop.length >= 84 && bit(u16(dop, 82), 15)) out.push("<w:gutterAtTop/>")
	if (bit(flags, 8)) out.push("<w:hideSpellingErrors/>")
	if (bit(flags, 9)) out.push("<w:hideGrammaticalErrors/>")
	if (bit(flags, 15)) out.push("<w:trackRevisions/>")

	// Editing restrictions, enforced (§17.15.1.29). The password: lKeyProtDoc is the legacy verifier Word hashes for
	// the transitional attributes (ECMA-376 1st ed. Part 4 §2.15.1.28; MS-DOC §2.7.2 lKeyProtDoc), so the hash of the
	// key asks for the same password; SHA-1 is cryptAlgorithmSid 4.
	const protection = dopProtection(dop)

	if (protection !== undefined) {
		const key = protectionHash === undefined ? "" : protectionKeyAttributes(protectionHash)

		out.push(`<w:documentProtection${attr("w:edit", protection.edit)} w:enforcement="1"${key}/>`)
	}

	if (dop.length >= 12) {
		const tab = u16(dop, 10)

		out.push(val("defaultTabStop", tab === 0 ? 720 : clamp(tab, 1, 31680)))
	}

	if (bit(flags, 12)) out.push("<w:autoHyphenation/>")

	if (dop.length >= 18) {
		const limit = u16(dop, 16)
		const zone = u16(dop, 14)

		if (limit > 0 && limit < 0x8000) out.push(val("consecutiveHyphenLimit", limit))
		if (zone > 0 && zone < 0x8000) out.push(val("hyphenationZone", zone))
	}

	if (bit(flags, 12) && !bit(flags, 11)) out.push("<w:doNotHyphenateCaps/>")
	if (bit(dop[0] ?? 0, 0)) out.push("<w:evenAndOddHeaders/>")
	if (dop.length >= 56 && !bit(formFlags, 12)) out.push("<w:doNotShadeFormData/>")

	// Before Word 2002 (nFib ≤ 0x00D9) footnote placement and note numbering are document-wide (DopBase fpc/rncFtn/
	// nFtn, rncEdn/nEdn); later files keep them per section. Endnote placement (DopBase epc) is document-wide in every
	// version: no section sprm carries it.
	const documentWide = model.fib.nFib <= 0x00d9 && dop.length >= 56

	if (notes.footnotes) {
		let props = ""

		if (documentWide) {
			const fpc = ((dop[0] ?? 0) >> 5) & 3
			const word = u16(dop, 2)

			props += val("pos", fpc === 0 ? "sectEnd" : fpc === 2 ? "beneathText" : "pageBottom")
			if (word >> 2 > 0) props += val("numStart", word >> 2)
			props += val("numRestart", ["continuous", "eachSect", "eachPage"][word & 3] ?? "continuous")
		}

		out.push(`<w:footnotePr>${props}<w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>`)
	}

	if (notes.endnotes) {
		let props = dop.length >= 56 ? val("pos", (formFlags & 3) === 3 ? "docEnd" : "sectEnd") : ""

		if (documentWide) {
			const word = u16(dop, 52)

			if (word >> 2 > 0) props += val("numStart", word >> 2)
			props += val("numRestart", ["continuous", "eachSect", "eachPage"][word & 3] ?? "continuous")
		}

		out.push(`<w:endnotePr>${props}<w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>`)
	}

	out.push(
		`<w:compat>${compatElements(dop)
			.map(name => `<w:${name}/>`)
			.join("")}<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="11"/></w:compat>`
	)
	out.push("</w:settings>")

	return out.join("")
}
