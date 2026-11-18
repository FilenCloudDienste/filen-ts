import { littleEndianByteArrayParser, type DataSet, type Element } from "dicom-parser"
import { DICOM_TAGS } from "@/features/preview/lib/dicom/dicomTags.generated"
import type { DicomTagLevel, DicomTagRow } from "@/features/preview/lib/dicom/protocol"

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

// Specific Character Set's defined terms (PS3.3 C.12.1.1.2) to WHATWG encoding labels; code extensions (ISO 2022) are
// read as their first, single-byte set.
const CHARSETS: Readonly<Record<string, string>> = {
	"ISO_IR 100": "iso-8859-1",
	"ISO_IR 101": "iso-8859-2",
	"ISO_IR 109": "iso-8859-3",
	"ISO_IR 110": "iso-8859-4",
	"ISO_IR 144": "iso-8859-5",
	"ISO_IR 127": "iso-8859-6",
	"ISO_IR 126": "iso-8859-7",
	"ISO_IR 138": "iso-8859-8",
	"ISO_IR 148": "iso-8859-9",
	"ISO_IR 203": "iso-8859-15",
	"ISO_IR 13": "shift_jis",
	"ISO_IR 166": "windows-874",
	"ISO_IR 192": "utf-8",
	GB18030: "gb18030",
	GBK: "gbk",
	"ISO 2022 IR 100": "iso-8859-1",
	"ISO 2022 IR 101": "iso-8859-2",
	"ISO 2022 IR 144": "iso-8859-5",
	"ISO 2022 IR 126": "iso-8859-7",
	"ISO 2022 IR 138": "iso-8859-8",
	"ISO 2022 IR 148": "iso-8859-9",
	"ISO 2022 IR 13": "shift_jis",
	"ISO 2022 IR 166": "windows-874"
}

// The decoder for a data set's text, from its Specific Character Set (0008,0005).
export function textDecoderFor(dataSet: DataSet): TextDecoder {
	const declared = dataSet.string("x00080005")
	const terms = (declared ?? "").split("\\").map(term => term.trim())
	const label = CHARSETS[terms.find(term => term !== "") ?? ""] ?? CHARSETS[terms[1] ?? ""] ?? "iso-8859-1"

	try {
		return new TextDecoder(label)
	} catch {
		return new TextDecoder("iso-8859-1")
	}
}

function vrOf(element: Element): string {
	if (element.vr !== undefined) return element.vr

	const entry = dictionaryEntry(element.tag)

	return entry === null ? "UN" : entry.vr
}

function held(dataSet: DataSet, element: Element): boolean {
	return element.length !== 0xffffffff && element.dataOffset + element.length <= dataSet.byteArray.length
}

function cut(text: string): string {
	return text.length > TAG_VALUE_CHARS ? `${text.slice(0, TAG_VALUE_CHARS)}…` : text
}

function numbers(dataSet: DataSet, element: Element, vr: string): string {
	const size = NUMBER_SIZES[vr] ?? 1
	const count = Math.min(NUMBERS_SHOWN, Math.floor(element.length / size))
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

	const shown = values.join("\\")

	return Math.floor(element.length / size) > count ? `${shown}\\…` : shown
}

function valueOf(dataSet: DataSet, element: Element, vr: string, decoder: TextDecoder): string | null {
	if (!held(dataSet, element) || element.length === 0) {
		return element.length === 0 ? "" : null
	}

	if (TEXT_VRS.has(vr)) {
		// Long text past the cut is never decoded whole.
		const bytes = dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + Math.min(element.length, TAG_VALUE_CHARS * 4))
		const text = (vr === "UI" ? new TextDecoder("ascii") : decoder).decode(bytes).replace(/[\0 ]+$/, "")

		return cut(text)
	}

	if (vr in NUMBER_SIZES) {
		return numbers(dataSet, element, vr)
	}

	return null
}

function elementRow(dataSet: DataSet, element: Element, decoder: TextDecoder): DicomTagRow {
	const vr = vrOf(element)
	const isPrivate = isPrivateTag(element.tag)
	const entry = isPrivate ? null : dictionaryEntry(element.tag)

	return {
		tag: displayTag(element.tag),
		vr,
		name: entry?.name ?? null,
		item: null,
		value: element.items === undefined ? valueOf(dataSet, element, vr, decoder) : null,
		length: element.hadUndefinedLength === true ? -1 : element.length,
		children: element.items?.length ?? 0,
		isPrivate
	}
}

function sortedElements(dataSet: DataSet): Element[] {
	return Object.values(dataSet.elements).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

// The rows under `path` (indices from the root: an element, then its item, then that item's element, …).
export function tagLevel(root: DataSet, path: readonly number[], decoder: TextDecoder): DicomTagLevel {
	let dataSet: DataSet = root
	let items: Element[] | null = null

	for (const index of path) {
		if (items === null) {
			const element = sortedElements(dataSet)[index]

			if (element?.items === undefined) return { rows: [], more: 0 }

			items = element.items
		} else {
			const item = items[index]?.dataSet

			if (item === undefined) return { rows: [], more: 0 }

			dataSet = item
			items = null
		}
	}

	if (items !== null) {
		const rows = items.slice(0, TAG_ROWS_MAX).map((item, index) => ({
			tag: "(FFFE,E000)",
			vr: "",
			name: null,
			item: index + 1,
			value: null,
			length: item.hadUndefinedLength === true ? -1 : item.length,
			children: item.dataSet === undefined ? 0 : Object.keys(item.dataSet.elements).length,
			isPrivate: false
		}))

		return { rows, more: Math.max(0, items.length - TAG_ROWS_MAX) }
	}

	const elements = sortedElements(dataSet)

	return {
		rows: elements.slice(0, TAG_ROWS_MAX).map(element => elementRow(dataSet, element, decoder)),
		more: Math.max(0, elements.length - TAG_ROWS_MAX)
	}
}
