import { canonicalAttributes, elementName, readElement, type OdfElement } from "../../odf/tree"
import { SHEET_MAX_CELL_TEXT } from "../../sheet/protocol"
import { escapeAttribute, Namespaces, NodeKind, parseXml, XmlError, type XmlDocument } from "../../xml/index"
import { OdsReadError } from "./errors"

const encoder = new TextEncoder()

// The most spaces one text:s stands for (text:c, §19.763): the longest run of spaces in a cell the writer writes, so
// what it wrote reads back. A few bytes of markup stand for this many characters: what the reader builds from them is
// bounded by MAX_CAPTURED_TEXT (captured markup) and the content reader's own limit (cells).
export const MAX_SPACE_RUN = SHEET_MAX_CELL_TEXT
// The most characters the text of captured markup comes to: a note, or all of a sheet's validation messages.
export const MAX_CAPTURED_TEXT = 16 * 1024 * 1024

// The spaces a text:s stands for: its text:c, at least one (also for a count that does not read) and at most `max`.
export function spaceCount(count: string | undefined, max: number = MAX_SPACE_RUN): number {
	const value = Number(count ?? "1")

	return Number.isFinite(value) && value >= 1 ? Math.min(max, Math.floor(value)) : 1
}

// What text read from captured markup may still come to, in characters.
export interface TextBudget {
	chars: number
}

export function textBudget(): TextBudget {
	return { chars: MAX_CAPTURED_TEXT }
}

// Takes `length` characters from the budget; the markup is refused once it is spent.
export function chargeText(budget: TextBudget, length: number): void {
	budget.chars -= length

	if (budget.chars < 0) throw new OdsReadError("tooLarge", "The spreadsheet holds more text in a note or message than the limit")
}

// A small element captured from content.xml (validations, names, an annotation...), parsed under the namespace
// declarations in force where it was captured.
export interface Captured {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly node: number
}

export function parseCaptured(markup: Uint8Array, prefixes: ReadonlyMap<string, string>): Captured {
	let declarations = ""

	for (const [prefix, uri] of prefixes) declarations += ` ${prefix === "" ? "xmlns" : `xmlns:${prefix}`}="${escapeAttribute(uri)}"`

	const head = encoder.encode(`<captured${declarations}>`)
	const tail = encoder.encode("</captured>")
	const bytes = new Uint8Array(head.length + markup.length + tail.length)

	bytes.set(head)
	bytes.set(markup, head.length)
	bytes.set(tail, head.length + markup.length)

	try {
		const document = parseXml(bytes)
		const node = document.firstChildElement(document.documentElement())

		if (node < 0) throw new OdsReadError("malformed", "An empty element was captured")

		return { document, namespaces: new Namespaces(document, { lenient: true }), node }
	} catch (error) {
		if (error instanceof XmlError) throw new OdsReadError("malformed", `content.xml: ${error.message}`)

		throw error
	}
}

// The captured element as a tree with canonical names.
export function capturedElement(markup: Uint8Array, prefixes: ReadonlyMap<string, string>): OdfElement {
	const { document, namespaces, node } = parseCaptured(markup, prefixes)

	return readElement(document, namespaces, node)
}

// The text of an element in document order: paragraphs (text:p, text:h) on lines of their own, text:s, text:tab and
// text:line-break as the characters they stand for, other inline elements (spans, links, fields) by their text. Refused
// as tooLarge once it would pass what `budget` holds.
export function capturedText(
	{ document, namespaces, node }: Captured,
	skip: ReadonlySet<string> = new Set(),
	budget: TextBudget = textBudget()
): string {
	const lines: string[] = []
	let line: string[] | null = null

	const walk = (parent: number): void => {
		for (let child = document.firstChild(parent); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Text || kind === NodeKind.CData) {
				if (line === null) continue

				const text = document.text(child)

				chargeText(budget, text.length)
				line.push(text)

				continue
			}

			if (kind !== NodeKind.Element) continue

			const name = elementName(document, namespaces, child)

			if (skip.has(name)) continue

			if (name === "text:p" || name === "text:h") {
				const outer = line

				line = []
				walk(child)
				// The line end that joins it to the next.
				chargeText(budget, 1)
				lines.push(line.join(""))
				line = outer
			} else if (name === "text:s") {
				if (line === null) continue

				const count = spaceCount(canonicalAttributes(document, namespaces, child).get("text:c"))

				chargeText(budget, count)
				line.push(" ".repeat(count))
			} else if (name === "text:tab") {
				chargeText(budget, 1)
				line?.push("\t")
			} else if (name === "text:line-break") {
				chargeText(budget, 1)
				line?.push("\n")
			} else {
				walk(child)
			}
		}
	}

	walk(node)

	return lines.join("\n")
}

// Validations captured between yields.
const VALIDATIONS_PER_STEP = 256

// table:content-validations parsed once, in steps: the element, and each validation's help and error messages (by
// table:name) as their text in document order (capturedText): the element tree keeps an element's character data
// apart from its children, which loses where a text:s was.
export function* capturedValidationsSteps(
	markup: Uint8Array,
	prefixes: ReadonlyMap<string, string>
): Generator<void, { readonly element: OdfElement; readonly messages: Map<string, { help: string; error: string }> }> {
	const captured = parseCaptured(markup, prefixes)
	const { document, namespaces, node } = captured
	const children: OdfElement[] = []
	const messages = new Map<string, { help: string; error: string }>()
	// All the messages together, as they are kept and copied into the rules.
	const budget = textBudget()
	let text = ""
	let step = 0

	yield

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const kind = document.kind(child)

		if (kind === NodeKind.Text || kind === NodeKind.CData) text += document.text(child)
		if (kind !== NodeKind.Element) continue
		if (++step % VALIDATIONS_PER_STEP === 0) yield

		children.push(readElement(document, namespaces, child, 1))

		if (elementName(document, namespaces, child) !== "table:content-validation") continue

		const name = canonicalAttributes(document, namespaces, child).get("table:name")

		if (name === undefined) continue

		const own = { help: "", error: "" }

		for (let message = document.firstChildElement(child); message >= 0; message = document.nextSiblingElement(message)) {
			const which = elementName(document, namespaces, message)

			if (which === "table:help-message") own.help = capturedText({ document, namespaces, node: message }, undefined, budget)
			else if (which === "table:error-message") own.error = capturedText({ document, namespaces, node: message }, undefined, budget)
		}

		messages.set(name, own)
	}

	return {
		element: {
			name: elementName(document, namespaces, node),
			attributes: canonicalAttributes(document, namespaces, node),
			children,
			text
		},
		messages
	}
}
