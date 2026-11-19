import { encodeUtf8, parseXml } from "@filen/office/core/xml"
import { mathChecks } from "../core/docx/write/checks/math"
import type { CheckInput, CheckedPart } from "../core/docx/write/checks/index"
import { partReader } from "../core/docx/model/reader"
import { NAMESPACES } from "./docxSynthetic"

// Gate 2's math checks on new markup, as a save runs them on the skeleton of word/document.xml.

export const MATH_CHECK_INPUT = { original: { has: () => true }, context: { model: { strict: false } } } as unknown as CheckInput

// The source part a checked skeleton stands in (what its copies are of): `body`'s.
function sourcePart(body = ""): CheckedPart["part"] {
	const document = parseXml(encodeUtf8(`<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`))

	return { document, reader: partReader(document) } as unknown as CheckedPart["part"]
}

export interface MathGateOptions {
	// The namespaces the skeleton's root declares.
	readonly root?: string
	// The body of the source part the skeleton stands in.
	readonly source?: string
}

// A skeleton of one paragraph holding `inner`.
export function checkedPart(inner: string, options: MathGateOptions = {}): CheckedPart {
	const document = parseXml(encodeUtf8(`<w:document ${options.root ?? NAMESPACES}><w:body><w:p>${inner}</w:p></w:body></w:document>`))

	return { name: "word/document.xml", part: sourcePart(options.source), document, skeleton: true }
}

// Why the math checks refuse a paragraph holding `inner`, undefined when they pass it (an async check awaited).
export async function mathGate(inner: string, options: MathGateOptions = {}): Promise<string | undefined> {
	try {
		for (const check of mathChecks) await check.part?.(MATH_CHECK_INPUT, checkedPart(inner, options))

		return undefined
	} catch (error) {
		return (error as Error).message
	}
}
