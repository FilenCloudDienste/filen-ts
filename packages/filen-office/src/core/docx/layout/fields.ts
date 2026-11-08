import { dateTimeResult, parseFieldCode } from "../fields/code"
import { Item } from "../model/kinds"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/part"
import { macroButtonText } from "../model/macroButton"
import { englishCardinal, englishOrdinal, formatNumber } from "../numbering/formats"
import type { ResolvedLanguage } from "../props/types"

// Fields whose result layout computes instead of showing the cached result Word stored: page numbers per page,
// legacy check boxes and drop-down lists, which Word draws from their w:ffData (ECMA-376 Part 1 §17.16.17), and
// DATE and TIME, which Word shows as of the time the document is opened or printed unless the field is locked
// (w:fldLock). CREATEDATE, SAVEDATE, PRINTDATE and EDITTIME keep their stored results.
export const FieldKind = { OTHER: 0, PAGE: 1, NUMPAGES: 2, SECTIONPAGES: 3, CHECKBOX: 4, DROPDOWN: 5, DATE: 6, TIME: 7 } as const

export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind]

export interface FieldInfo {
	readonly kind: FieldKind
	// The ST_NumberFormat a \* switch asks for, or undefined to use the section's (PAGE) or decimal.
	readonly format: string | undefined
}

const OTHER: FieldInfo = { kind: FieldKind.OTHER, format: undefined }
const CHECKBOX: FieldInfo = { kind: FieldKind.CHECKBOX, format: undefined }
const DROPDOWN: FieldInfo = { kind: FieldKind.DROPDOWN, format: undefined }
const DATE: FieldInfo = { kind: FieldKind.DATE, format: undefined }
const TIME: FieldInfo = { kind: FieldKind.TIME, format: undefined }

// \* general formatting switches that format numbers (ECMA-376 §17.16.4.3, Microsoft's "Format field results"),
// as ST_NumberFormat values, or the switch's own name for text a field writes lower case (cardText, ordText,
// dollarText: the formats of lists and sections capitalize). Roman and Alphabetic give their case by their
// own (\* roman lower case, \* ROMAN or \* Roman upper case); the others match in any case (\* Hex upper case
// digits whichever).
const CASED_SWITCHES: Readonly<Record<string, string>> = {
	roman: "lowerRoman",
	Roman: "upperRoman",
	ROMAN: "upperRoman",
	alphabetic: "lowerLetter",
	ALPHABETIC: "upperLetter",
	Alphabetic: "upperLetter"
}
const NUMBER_SWITCHES: Readonly<Record<string, string>> = {
	arabic: "decimal",
	arabicdash: "numberInDash",
	ordinal: "ordinal",
	cardtext: "cardText",
	ordtext: "ordText",
	dollartext: "dollarText",
	hex: "hex"
}

// The ST_NumberFormat a \* switch argument asks for, or undefined for one that formats no number.
export function numberSwitchFormat(name: string): string | undefined {
	return CASED_SWITCHES[name] ?? (/^(roman|alphabetic)$/i.test(name) ? undefined : NUMBER_SWITCHES[name.toLowerCase()])
}

const FIELD = /^\s*([A-Za-z]+)/
const SWITCH = /\\\*\s*([A-Za-z]+)/g

// What layout computes for a field with instruction `instruction`, whose begin w:fldChar (or w:fldSimple) is
// `item` of `part`: a locked one (w:fldLock) keeps its stored date or time, as Word updates no locked field.
export function fieldInfo(instruction: string, part?: StoryPart, item = -1): FieldInfo {
	const type = FIELD.exec(instruction)?.[1]?.toUpperCase()

	if (type === "DATE" || type === "TIME")
		return part !== undefined && item >= 0 && fieldLocked(part, item) ? OTHER : type === "DATE" ? DATE : TIME

	const kind =
		type === "PAGE"
			? FieldKind.PAGE
			: type === "NUMPAGES"
				? FieldKind.NUMPAGES
				: type === "SECTIONPAGES"
					? FieldKind.SECTIONPAGES
					: type === "FORMCHECKBOX"
						? FieldKind.CHECKBOX
						: type === "FORMDROPDOWN"
							? FieldKind.DROPDOWN
							: FieldKind.OTHER

	if (kind === FieldKind.OTHER) return OTHER
	if (kind === FieldKind.CHECKBOX || kind === FieldKind.DROPDOWN) return kind === FieldKind.CHECKBOX ? CHECKBOX : DROPDOWN

	let format: string | undefined

	for (const match of instruction.matchAll(SWITCH)) format = numberSwitchFormat(match[1] ?? "") ?? format

	return { kind, format }
}

export { macroButtonText }

// Whether the field whose begin w:fldChar (or w:fldSimple) is `item` is locked (w:fldLock, §17.16.18, §17.16.19).
export function fieldLocked(part: StoryPart, item: number): boolean {
	return part.kinds[item] === Item.FieldChar ? part.fieldCharLocked(item) : part.reader.flag(part.node(item), Ns.W, "fldLock")
}

// What a DATE or TIME field with instruction `instruction` shows at `now` in language `lang` (its run's w:lang),
// as an update computes it (fields/code.ts dateTimeResult).
export function dateTimeText(instruction: string, now: Date, lang: ResolvedLanguage): string {
	return dateTimeResult(parseFieldCode(instruction), now, lang.latin, lang.eastAsia)
}

// The text a field with result text `result` and instruction `instruction` shows: its result, else a
// MACROBUTTON's display text.
export function shownFieldText(result: string, instruction: string): string {
	return result !== "" ? result : (macroButtonText(instruction) ?? "")
}

// A page number as a field shows it: the switch's format, else (PAGE) the section's w:pgNumType format.
export function numberText(value: number, format: string | undefined): string {
	switch (format) {
		case "cardText":
			return englishCardinal(value)
		case "ordText":
			return englishOrdinal(value)
		case "dollarText": {
			const cents = Math.round(Math.abs(value) * 100)

			return `${englishCardinal(Math.trunc(cents / 100) * Math.sign(value))} and ${String(cents % 100).padStart(2, "0")}/100`
		}
		default:
			return formatNumber(value, format ?? "decimal")
	}
}

export interface FormFieldLook {
	// A drop-down list's entry shown ("" for a check box).
	readonly text: string
	// Whether a check box is checked.
	readonly checked: boolean
	// The check box's own size (w:size, half-points), undefined when it takes its run's (w:sizeAuto).
	readonly size: number | undefined
}

// What a legacy check box or drop-down list whose begin w:fldChar is `item` shows: the box (layout draws it as
// Word does, see ObjectKind.CHECKBOX), checked as w:checked (else w:default) says, or the list entry w:result
// (else w:default, else the first) names.
export function formFieldLook(part: StoryPart, item: number, kind: FieldKind): FormFieldLook | undefined {
	if (part.kinds[item] !== Item.FieldChar) return undefined

	const reader = part.reader
	const ffData = reader.child(part.node(item), Ns.W, "ffData")

	if (ffData < 0) return undefined

	const child = (node: number, local: string): number => (node < 0 ? -1 : reader.child(node, Ns.W, local))
	const number = (node: number): number | undefined => {
		const value = node < 0 ? undefined : Number.parseInt(reader.attr(node, Ns.W, "val") ?? "", 10)

		return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
	}

	if (kind === FieldKind.CHECKBOX) {
		const box = child(ffData, "checkBox")

		if (box < 0) return undefined

		const checked = child(box, "checked")
		const fallback = child(box, "default")
		const on = checked >= 0 ? reader.onOff(checked) : fallback >= 0 && reader.onOff(fallback)
		const size = child(box, "sizeAuto") >= 0 ? undefined : number(child(box, "size"))

		return { text: "", checked: on, size: size === undefined || size < 2 ? undefined : size }
	}

	const list = child(ffData, "ddList")

	if (list < 0) return undefined

	const document = part.document
	const entries: string[] = []

	for (let entry = document.firstChildElement(list); entry >= 0; entry = document.nextSiblingElement(entry))
		if (reader.is(entry, Ns.W, "listEntry")) entries.push(reader.attr(entry, Ns.W, "val") ?? "")

	const chosen = number(child(list, "result")) ?? number(child(list, "default")) ?? 0

	return { text: entries[chosen] ?? entries[0] ?? "", checked: false, size: undefined }
}

// Which fields show their codes instead of their results: all of them (Word's "Field codes" view, Alt+F9) or
// none, except those `toggled` says were switched the other way one by one (Shift+F9), a field named by its
// part and its begin w:fldChar (or w:fldSimple) item. A view of the document, never saved.
export interface FieldCodes {
	readonly all: boolean
	readonly toggled: ((part: StoryPart, item: number) => boolean) | undefined
	// Whether paragraph `item` of `part`, laid out from an edit (a part of its own), lies inside a field spanning
	// paragraphs shown as its code that does not end in it: its mark is hidden as the source's are there.
	readonly within?: (part: StoryPart, item: number) => boolean
}
