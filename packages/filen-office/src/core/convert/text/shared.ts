import type { XmlDocument } from "../../xml/index"

// Constants and helpers the WordprocessingML converters share.

// Parts the ODT translator writes runs into (the body, headers and footers, notes, comments).
export const STORY = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/u

// ST_OnOff false.
export const OFF = new Set(["0", "false", "off"])

// An ST_OnOff element's w:val (or another attribute): off without the element, `unset` without the attribute.
export function isOn(document: XmlDocument, node: number, attribute = "w:val", unset = true): boolean {
	if (node < 0) return false

	const value = document.attribute(node, attribute)

	return value === undefined ? unset : !OFF.has(value)
}

// Word's number formats with an ODF form (Part 3 §19.474, letters as Word repeats them).
export const NUMBER_FORMATS: Readonly<Record<string, string>> = {
	decimal: "1",
	lowerRoman: "i",
	upperRoman: "I",
	lowerLetter: "a",
	upperLetter: "A"
}

// The relationships part of a package part.
export function relsName(part: string): string {
	const at = part.lastIndexOf("/")

	return `${part.slice(0, at + 1)}_rels/${part.slice(at + 1)}.rels`
}
