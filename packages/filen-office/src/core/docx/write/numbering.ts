import { XmlEditor, encodeUtf8, type XmlDocument } from "../../xml/index"
import type { ListStart, NewList } from "../edit/formats"
import type { Numbering } from "../numbering/index"
import { partReader } from "../model/reader"
import { Ns } from "../model/namespaces"
import { Names } from "./markup"
import { W_NAMESPACE } from "./story"

// Word's own nine-level definitions for a new bulleted or numbered list (hybridMultilevel, half-inch steps).
const BULLETS: readonly (readonly [string, string])[] = [
	["", "Symbol"],
	["o", "Courier New"],
	["", "Wingdings"]
]
const NUMBER_FORMATS = ["decimal", "lowerLetter", "lowerRoman"] as const

// `first`: the first level's number format, text and start a list AutoFormat started takes.
export function abstractNumbering(names: Names, id: number, kind: NewList["kind"], first?: ListStart): string {
	let levels = ""

	for (let level = 0; level < 9; level++) {
		const left = String(720 * (level + 1))

		if (kind === "bullet") {
			const [text, font] = BULLETS[level % 3] as readonly [string, string]

			levels +=
				`<${names.el("lvl")} ${names.attr("ilvl")}="${level}">${names.val("start", "1")}${names.val("numFmt", "bullet")}${names.val("lvlText", text)}` +
				`${names.val("lvlJc", "left")}<${names.el("pPr")}>${names.empty("ind", [
					["left", left],
					["hanging", "360"]
				])}</${names.el("pPr")}><${names.el("rPr")}>` +
				`${names.empty("rFonts", [
					["ascii", font],
					["hAnsi", font],
					["hint", "default"]
				])}</${names.el("rPr")}></${names.el("lvl")}>`
		} else {
			const own = level === 0 ? first : undefined
			const format = own?.format ?? NUMBER_FORMATS[level % 3] ?? "decimal"
			const roman = format === "lowerRoman" || format === "upperRoman"
			// Word hangs its right-aligned roman levels 180, so the numeral ends 180 before the text.
			const indent = names.empty("ind", [
				["left", left],
				["hanging", roman ? "180" : "360"]
			])

			levels +=
				`<${names.el("lvl")} ${names.attr("ilvl")}="${level}">${names.val("start", String(own?.start ?? 1))}${names.val("numFmt", format)}` +
				`${names.val("lvlText", `%${level + 1}${own?.suffix ?? "."}`)}${names.val("lvlJc", roman ? "right" : "left")}` +
				`<${names.el("pPr")}>${indent}</${names.el("pPr")}></${names.el("lvl")}>`
		}
	}

	return `<${names.el("abstractNum")} ${names.attr("abstractNumId")}="${id}">${names.val("multiLevelType", "hybridMultilevel")}${levels}</${names.el("abstractNum")}>`
}

export function numberingInstance(names: Names, numId: number, abstractId: number, restart: boolean): string {
	const override = restart
		? `<${names.el("lvlOverride")} ${names.attr("ilvl")}="0">${names.val("startOverride", "1")}</${names.el("lvlOverride")}>`
		: ""

	return `<${names.el("num")} ${names.attr("numId")}="${numId}">${names.val("abstractNumId", String(abstractId))}${override}</${names.el("num")}>`
}

export const NUMBERING_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"

export interface NumberingWrite {
	// The file's w:numId for each new list.
	readonly numIds: ReadonlyMap<number, number>
	// numbering.xml with the definitions added (null when nothing was added).
	bytes(): Uint8Array | null
}

// New lists as w:num (and w:abstractNum where no existing definition is reused): abstract definitions go
// after the last existing one, instances after the last instance, as CT_Numbering orders them. Without a
// numbering part, a new one holds them.
export function planNumbering(
	document: XmlDocument | undefined,
	numbering: Numbering | undefined,
	lists: ReadonlyMap<number, NewList>
): NumberingWrite {
	const numIds = new Map<number, number>()

	if (lists.size === 0) return { numIds, bytes: () => null }

	let maxNum = 0
	let maxAbstract = -1

	for (const id of numbering?.instances.keys() ?? []) maxNum = Math.max(maxNum, id)
	for (const id of numbering?.abstracts.keys() ?? []) maxAbstract = Math.max(maxAbstract, id)

	const reader = document === undefined ? undefined : partReader(document)
	const root = document?.documentElement() ?? -1

	// The model skips definitions it cannot read; their ids are taken all the same.
	if (document !== undefined && reader !== undefined) {
		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.group(child) !== Ns.W) continue

			const local = document.localName(child)

			if (local === "num") maxNum = Math.max(maxNum, rawId(reader.attr(child, Ns.W, "numId")))
			else if (local === "abstractNum") maxAbstract = Math.max(maxAbstract, rawId(reader.attr(child, Ns.W, "abstractNumId")))
		}
	}
	const names = new Names(reader === undefined ? "w" : (reader.namespaces.prefixFor(root, W_NAMESPACE) ?? ""), "")
	let abstracts = ""
	let instances = ""

	for (const [id, list] of [...lists].sort(([a], [b]) => b - a)) {
		const numId = ++maxNum
		const based = list.basedOn === null ? undefined : numbering?.instances.get(list.basedOn)

		numIds.set(id, numId)

		if (based !== undefined) {
			instances += numberingInstance(names, numId, based.abstractId, true)
		} else {
			const abstractId = ++maxAbstract

			abstracts += abstractNumbering(names, abstractId, list.kind, list.first)
			instances += numberingInstance(names, numId, abstractId, false)
		}
	}

	return {
		numIds,
		bytes(): Uint8Array {
			if (document === undefined || reader === undefined) {
				return encodeUtf8(
					`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="${W_NAMESPACE}">${abstracts}${instances}</w:numbering>`
				)
			}

			const editor = new XmlEditor(document)
			let lastAbstract = -1
			let lastNum = -1
			let firstAfter = -1

			for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
				if (reader.group(child) !== Ns.W) continue

				const local = document.localName(child)

				if (local === "abstractNum") lastAbstract = child
				else if (local === "num") lastNum = child
				else if (local === "numIdMacAtCleanup" && firstAfter < 0) firstAfter = child
			}

			if (abstracts !== "") {
				if (lastAbstract >= 0) editor.insertAfter(lastAbstract, abstracts)
				else if (lastNum >= 0) editor.insertBefore(firstNum(document, reader, root), abstracts)
				else if (firstAfter >= 0) editor.insertBefore(firstAfter, abstracts)
				else editor.append(root, abstracts)
			}

			if (lastNum >= 0) editor.insertAfter(lastNum, instances)
			else if (firstAfter >= 0) editor.insertBefore(firstAfter, instances)
			else editor.append(root, instances)

			return editor.serialize()
		}
	}
}

function firstNum(document: XmlDocument, reader: ReturnType<typeof partReader>, root: number): number {
	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) === Ns.W && document.localName(child) === "num") return child
	}

	return -1
}

function rawId(value: string | undefined): number {
	const id = Number.parseInt(value ?? "", 10)

	return Number.isFinite(id) ? id : -1
}
