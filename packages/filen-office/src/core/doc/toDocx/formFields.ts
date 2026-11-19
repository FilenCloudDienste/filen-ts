import { le16, le32 } from "../bytes"
import type { DocModel } from "../model"
import type { DocFile } from "../read"
import { attr, val } from "./xml"

// Legacy form fields: FFData (§2.9.75) at the fData character of a FORMTEXT / FORMCHECKBOX / FORMDROPDOWN
// field's instruction → w:ffData on the field's begin character (ECMA-376 Part 1 §17.16.17).

const FFDATA_AT = 0x44
const TEXT_TYPES = ["regular", "number", "date", "currentDate", "currentTime", "calculated"]

// Xstz (§2.9.355): cch, the characters, a terminating zero.
function xstz(data: Uint8Array, at: number, end: number): readonly [string, number] {
	if (at + 2 > end) return ["", end]

	const cch = le16(data, at)
	const stop = at + 2 + 2 * cch

	if (stop > end) return ["", end]

	let out = ""

	for (let k = at + 2; k < stop; k += 2) out += String.fromCharCode(le16(data, k))

	return [out, stop + 2]
}

// The string types' lengths ST_FFName (65), ST_FFHelpTextVal (256), ST_FFStatusTextVal (140), ST_MacroName (33),
// ST_String for the format (64 as Word bounds it).
function cut(value: string, length: number): string {
	return value.length > length ? value.slice(0, length) : value
}

export function formFieldXml(data: Uint8Array, offset: number): string {
	const end = Math.min(data.length, offset + le32(data, offset))
	let at = offset + FFDATA_AT

	if (at + 10 > end) return ""

	const bits = le16(data, at + 4)
	const type = bits & 3
	const result = (bits >> 2) & 0x1f
	const ownHelp = (bits & 0x80) !== 0
	const ownStatus = (bits & 0x100) !== 0
	const sizeExact = (bits & 0x400) !== 0
	const textType = (bits >> 11) & 7
	const recalc = (bits & 0x4000) !== 0
	const maxLength = le16(data, at + 6)
	const size = le16(data, at + 8)

	at += 10

	const [name, afterName] = xstz(data, at, end)

	at = afterName

	let textDefault = ""
	let wDef = 0

	if (type === 0) [textDefault, at] = xstz(data, at, end)
	else {
		wDef = le16(data, at)
		at += 2
	}

	const [format, afterFormat] = xstz(data, at, end)
	const [help, afterHelp] = xstz(data, afterFormat, end)
	const [status, afterStatus] = xstz(data, afterHelp, end)
	const [entry, afterEntry] = xstz(data, afterStatus, end)
	const [exit, afterExit] = xstz(data, afterEntry, end)
	let out = "<w:ffData>"

	out += val("name", cut(name, 65))

	if (recalc) out += "<w:calcOnExit/>"
	else out += '<w:calcOnExit w:val="0"/>'

	if (entry !== "") out += val("entryMacro", cut(entry, 33))
	if (exit !== "") out += val("exitMacro", cut(exit, 33))
	if (help !== "") out += `<w:helpText${ownHelp ? ' w:type="text"' : ' w:type="autoText"'}${attr("w:val", cut(help, 256))}/>`
	if (status !== "") out += `<w:statusText${ownStatus ? ' w:type="text"' : ' w:type="autoText"'}${attr("w:val", cut(status, 140))}/>`

	if (type === 1) {
		out += `<w:checkBox>${sizeExact ? val("size", Math.max(2, size)) : "<w:sizeAuto/>"}${val("default", wDef !== 0 ? 1 : 0)}${
			result === 25 ? "" : val("checked", result !== 0 ? 1 : 0)
		}</w:checkBox>`
	} else if (type === 2) {
		// hsttbDropList: an extended STTB of the entries.
		const entries: string[] = []
		let cursor = afterExit

		if (cursor + 6 <= end && le16(data, cursor) === 0xffff) {
			const count = Math.min(25, le16(data, cursor + 2))

			cursor += 6

			for (let k = 0; k < count && cursor + 2 <= end; k++) {
				const cch = le16(data, cursor)

				if (cursor + 2 + 2 * cch > end) break

				let item = ""

				for (let j = 0; j < cch; j++) item += String.fromCharCode(le16(data, cursor + 2 + 2 * j))

				entries.push(item)
				cursor += 2 + 2 * cch
			}
		}

		out += `<w:ddList>${result === 25 ? "" : val("result", result)}${val("default", wDef)}${entries.map(item => val("listEntry", item)).join("")}</w:ddList>`
	} else {
		out += `<w:textInput>${val("type", TEXT_TYPES[textType] ?? "regular")}${textDefault === "" ? "" : val("default", textDefault)}${
			maxLength > 0 ? val("maxLength", maxLength) : ""
		}${format === "" ? "" : val("format", cut(format, 64))}</w:textInput>`
	}

	return `${out}</w:ffData>`
}

// FORMTEXT 70, FORMCHECKBOX 71, FORMDROPDOWN 83 (flt, §2.9.90).
const FORM_TYPES = new Set([70, 71, 83])

export function readFormFields(model: DocModel, file: DocFile): Map<number, string> {
	const out = new Map<number, string>()
	const data = file.data

	if (data === undefined) return out

	const markers = model.placeholders.filter(placeholder => placeholder.kind === "formField").sort((a, b) => a.cp - b.cp)

	if (markers.length === 0) return out

	for (const field of model.fields) {
		if (!FORM_TYPES.has(field.type)) continue

		const stop = field.separator ?? field.end
		let low = 0
		let high = markers.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((markers[middle]?.cp ?? 0) <= field.begin) low = middle + 1
			else high = middle
		}

		const marker = markers[low]

		if (marker?.kind !== "formField" || marker.cp >= stop) continue

		const xml = formFieldXml(data, marker.dataOffset)

		if (xml !== "") out.set(field.begin, xml)
	}

	return out
}
