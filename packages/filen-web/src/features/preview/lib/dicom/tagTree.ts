import { littleEndianByteArrayParser, type DataSet, type Element } from "dicom-parser"
import { DICOM_TAGS } from "@/features/preview/lib/dicom/dicomTags.generated"
import type { DicomTagLevel, DicomTagRow } from "@/features/preview/lib/dicom/protocol"
import { dicomText, type DicomText } from "@/features/preview/lib/dicom/charset.logic"
import { withoutPadding } from "@/features/preview/lib/dicom/transferSyntax"

// A parsed file's elements as rows of a tree, named from the PS3.6 dictionary: the worker's side of the tag panel. A
// sequence's children are its items, an item's its elements. Only one level is built per request, and at most
// TAG_ROWS_MAX rows of it; values are cut at TAG_VALUE_CHARS. Nothing here is logged.

export const TAG_ROWS_MAX = 5000
export const TAG_VALUE_CHARS = 1024
// Values of a numeric element shown, at most.
const NUMBERS_SHOWN = 64

interface Entry {
	readonly vr: string
	readonly name: string
}

let exact: Map<string, Entry> | null = null
let masked: { readonly pattern: string; readonly entry: Entry }[] = []

function dictionary(): Map<string, Entry> {
	if (exact === null) {
		exact = new Map()
		masked = []

		for (const line of DICOM_TAGS.split("\n")) {
			const [key = "", vr = "", name = ""] = line.split("\t")

			if (key.includes("x")) masked.push({ pattern: key, entry: { vr, name } })
			else exact.set(key, { vr, name })
		}
	}

	return exact
}

// The dictionary's entry for a tag as dicom-parser keys it ("x7fe00010").
export function dictionaryEntry(tag: string): Entry | null {
	const key = tag.slice(1).toUpperCase()
	const found = dictionary().get(key)

	if (found !== undefined) return found

	for (const { pattern, entry } of masked) {
		let matches = true

		for (let i = 0; i < 8 && matches; i++) {
			const want = pattern[i]

			matches = want === "x" || want === key[i]
		}

		if (matches) return entry
	}

	return null
}

export function displayTag(tag: string): string {
	const key = tag.slice(1).toUpperCase()

	return `(${key.slice(0, 4)},${key.slice(4)})`
}

function isPrivateTag(tag: string): boolean {
	return Number.parseInt(tag.slice(1, 5), 16) % 2 === 1
}

const TEXT_VRS = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT"])

const NUMBER_SIZES: Readonly<Record<string, number>> = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4, SV: 8, UV: 8 }

// The text of a data set: its own Specific Character Set, else the one it is nested in (an item inherits its parent's).
export function textOf(dataSet: DataSet, parent: DicomText | null): DicomText {
	const declared = dataSet.elements["x00080005"] === undefined ? undefined : (dataSet.string("x00080005") ?? "")

	return declared === undefined && parent !== null ? parent : dicomText(declared)
}

// An element's VR: the file's own (explicit VR), else the dictionary's. Where the dictionary allows more than one, US
// or SS follows Pixel Representation (the values the pixels hold, PS3.5 A.1) and any other takes its first.
function vrOf(element: Element, signed: boolean): string {
	if (element.vr !== undefined) return element.vr

	const entry = dictionaryEntry(element.tag)

	if (entry === null) return "UN"

	const alternatives = entry.vr.split("/")

	if (alternatives.includes("US") && alternatives.includes("SS")) return signed ? "SS" : "US"

	return alternatives[0] ?? "UN"
}

function held(dataSet: DataSet, element: Element): boolean {
	return element.length !== 0xffffffff && element.dataOffset + element.length <= dataSet.byteArray.length
}

// A value as text, and whether it was cut short of the whole.
interface Value {
	readonly text: string
	readonly truncated: boolean
}

// At most `limit` of a numeric element's values.
function numbers(dataSet: DataSet, element: Element, vr: string, limit: number): Value {
	const size = NUMBER_SIZES[vr] ?? 1
	const total = Math.floor(element.length / size)
	const count = Math.min(limit, total)
	const values: string[] = []
	const tag = element.tag

	for (let i = 0; i < count; i++) {
		switch (vr) {
			case "US":
				values.push(String(dataSet.uint16(tag, i)))
				break
			case "SS":
				values.push(String(dataSet.int16(tag, i)))
				break
			case "UL":
				values.push(String(dataSet.uint32(tag, i)))
				break
			case "SL":
				values.push(String(dataSet.int32(tag, i)))
				break
			case "FL":
				values.push(String(dataSet.float(tag, i)))
				break
			case "FD":
				values.push(String(dataSet.double(tag, i)))
				break
			case "AT": {
				const group = dataSet.uint16(tag, i * 2) ?? 0
				const number = dataSet.uint16(tag, i * 2 + 1) ?? 0

				values.push(`(${group.toString(16).toUpperCase().padStart(4, "0")},${number.toString(16).toUpperCase().padStart(4, "0")})`)
				break
			}
			default: {
				const view = new DataView(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + element.dataOffset + i * 8, 8)
				const little = dataSet.byteArrayParser === littleEndianByteArrayParser

				values.push(vr === "SV" ? String(view.getBigInt64(0, little)) : String(view.getBigUint64(0, little)))
			}
		}
	}

	return { text: values.join("\\"), truncated: total > count }
}

// An element's value as text: cut for its row (TAG_VALUE_CHARS, NUMBERS_SHOWN), or `whole` for a copy of it. Null for
// binary data, or a value past what was read.
function valueOf(dataSet: DataSet, element: Element, vr: string, text: DicomText, whole: boolean): Value | null {
	if (!held(dataSet, element) || element.length === 0) {
		return element.length === 0 ? { text: "", truncated: false } : null
	}

	if (TEXT_VRS.has(vr)) {
		// Long text past the cut is never decoded whole for its row.
		const length = whole ? element.length : Math.min(element.length, TAG_VALUE_CHARS * 4)
		const value = withoutPadding(text.decode(dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + length), vr))

		if (whole) return { text: value, truncated: false }

		return { text: value.slice(0, TAG_VALUE_CHARS), truncated: value.length > TAG_VALUE_CHARS || length < element.length }
	}

	if (vr in NUMBER_SIZES) {
		return numbers(dataSet, element, vr, whole ? Number.POSITIVE_INFINITY : NUMBERS_SHOWN)
	}

	return null
}

function elementRow(dataSet: DataSet, element: Element, text: DicomText, signed: boolean): DicomTagRow {
	const vr = vrOf(element, signed)
	const isPrivate = isPrivateTag(element.tag)
	const entry = isPrivate ? null : dictionaryEntry(element.tag)
	const value = element.items === undefined ? valueOf(dataSet, element, vr, text, false) : null

	return {
		tag: displayTag(element.tag),
		vr,
		name: entry?.name ?? null,
		item: null,
		value: value === null ? null : value.truncated ? `${value.text}${TEXT_VRS.has(vr) ? "" : "\\"}…` : value.text,
		truncated: value?.truncated ?? false,
		length: element.hadUndefinedLength === true ? -1 : element.length,
		children: element.items?.length ?? 0,
		isPrivate
	}
}

function sortedElements(dataSet: DataSet): Element[] {
	return Object.values(dataSet.elements).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

interface Level {
	readonly dataSet: DataSet
	readonly text: DicomText
	// A sequence's items, when `path` ends at the sequence; else the data set's elements are the level.
	readonly items: Element[] | null
}

// The level `path` leads to (indices from the root: an element, then its item, then that item's element, …), or null
// for a path that leads nowhere.
function levelAt(root: DataSet, path: readonly number[], rootText: DicomText): Level | null {
	let dataSet: DataSet = root
	let text = rootText
	let items: Element[] | null = null

	for (const index of path) {
		if (items === null) {
			const element = sortedElements(dataSet)[index]

			if (element?.items === undefined) return null

			items = element.items
		} else {
			const item = items[index]?.dataSet

			if (item === undefined) return null

			dataSet = item
			text = textOf(item, text)
			items = null
		}
	}

	return { dataSet, text, items }
}

function pixelsSigned(root: DataSet): boolean {
	return root.elements["x00280103"] !== undefined && root.uint16("x00280103") === 1
}

// The rows under `path`.
export function tagLevel(root: DataSet, path: readonly number[], rootText: DicomText): DicomTagLevel {
	const level = levelAt(root, path, rootText)

	if (level === null) return { rows: [], more: 0 }

	const { dataSet, text, items } = level

	if (items !== null) {
		const rows = items.slice(0, TAG_ROWS_MAX).map((item, index) => ({
			tag: "(FFFE,E000)",
			vr: "",
			name: null,
			item: index + 1,
			value: null,
			truncated: false,
			length: item.hadUndefinedLength === true ? -1 : item.length,
			children: item.dataSet === undefined ? 0 : Object.keys(item.dataSet.elements).length,
			isPrivate: false
		}))

		return { rows, more: Math.max(0, items.length - TAG_ROWS_MAX) }
	}

	const elements = sortedElements(dataSet)
	const signed = pixelsSigned(root)

	return {
		rows: elements.slice(0, TAG_ROWS_MAX).map(element => elementRow(dataSet, element, text, signed)),
		more: Math.max(0, elements.length - TAG_ROWS_MAX)
	}
}

// The whole value of the element at `path` (its row's path), for a copy of a row whose value was cut.
export function tagValue(root: DataSet, path: readonly number[], rootText: DicomText): string | null {
	const level = levelAt(root, path.slice(0, -1), rootText)

	if (level?.items !== null) return null

	const element = sortedElements(level.dataSet)[path.at(-1) ?? -1]

	if (element === undefined || element.items !== undefined) return null

	return valueOf(level.dataSet, element, vrOf(element, pixelsSigned(root)), level.text, true)?.text ?? null
}
