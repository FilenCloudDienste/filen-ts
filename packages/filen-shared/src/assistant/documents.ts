import { estimateTokens } from "./budget"
import { isRecord } from "./internal"
import { contextName } from "./search"

// What read_document returns, built the same way by the apps and the eval's fake app. The text travels as one entry
// per page, sheet or slide (`content`), so it keeps its unit boundaries through the sanitizing every tool result
// passes (which removes and replaces characters, so offsets into a joined text would drift); the content
// extraction reads it labelled, or in chunks of whole units, and none of it reaches the main model.

export type AssistantDocumentKind = "pdf" | "docx" | "sheet" | "slides" | "text"

// The most text one read takes: what the content extraction's chunks can cover at their cap (8 × ~6 KB of Latin
// text). The main model never sees it, only the extraction's answer.
export const DOCUMENT_READ_MAX_CHARS = 48_000

// What a read of the user's selection labels its one unit.
export const DOCUMENT_SELECTION_LABEL = "selection"

// A read that found no text, as a scanned PDF without recognized text has none.
export const DOCUMENT_NO_TEXT_NOTE = "No text in these pages: a scanned document without recognized text has none."

// One reading tool per file type: read_document for PDF, Office files and presentations, read_text_file for text,
// markdown, CSV, code and e-mail. Each refuses the other's files with a pointer to it. read_document still reads the
// selection in an open text file, and a text file too large for read_text_file, in chunks.
export function readWithTextFile(name: string): string {
	return `"${name}" is a text file; read it with read_text_file`
}

export function readWithDocument(name: string): string {
	return `"${name}" is not a text file; read a PDF, Word document, spreadsheet or presentation with read_document`
}

// A read of the selection with nothing selected: an invalid call, so the model retries with a read of the file itself
// (read_text_file for an open text file, its pages or all of it otherwise) instead of telling the user it found nothing.
export function nothingSelected(name: string, kind: AssistantDocumentKind): string {
	return kind === "text"
		? `Nothing is selected in "${name}"; read the file with read_text_file instead`
		: `Nothing is selected in "${name}"; read its ${DOCUMENT_UNIT_WORDS[kind].many} with part "pages" and from/to, or all of it with part "all"`
}

// The word a unit of each kind reads as: "pages 3–7 of 41". A text is one unit, cut in parts only when chunked.
export const DOCUMENT_UNIT_WORDS: Readonly<Record<AssistantDocumentKind, { one: string; many: string }>> = {
	pdf: { one: "page", many: "pages" },
	docx: { one: "page", many: "pages" },
	sheet: { one: "sheet", many: "sheets" },
	slides: { one: "slide", many: "slides" },
	text: { one: "part", many: "parts" }
}

export type AssistantDocumentUnit = {
	// 1-based, in the whole document.
	unit: number
	// "page 3", "slide 2", or a sheet's own name (other people's text).
	label: string
	text: string
}

export function isDocumentKind(value: unknown): value is AssistantDocumentKind {
	return typeof value === "string" && Object.hasOwn(DOCUMENT_UNIT_WORDS, value)
}

export function isDocumentUnit(value: unknown): value is AssistantDocumentUnit {
	return isRecord(value) && typeof value["unit"] === "number" && typeof value["label"] === "string" && typeof value["text"] === "string"
}

// A content field holding document units; null for any other content.
export function documentUnits(content: unknown): AssistantDocumentUnit[] | null {
	return Array.isArray(content) && content.length > 0 && content.every(isDocumentUnit) ? content : null
}

// The units a call asks for, clamped to the document: `part` "all" (or nothing asked) is every unit, "pages" (or a
// bare from/to) from `from` to `to`, `to` defaulting to `from`. Null for the selection.
export function documentReadRange(
	{ part, from, to }: { part?: unknown; from?: unknown; to?: unknown },
	units: number
): { from: number; to: number } | null {
	if (part === "selection") {
		return null
	}

	const first = typeof from === "number" ? from : undefined
	const last = typeof to === "number" ? to : undefined

	if (part === "all" || (first === undefined && last === undefined) || units < 1) {
		return { from: 1, to: Math.max(1, units) }
	}

	const start = Math.min(Math.max(1, Math.trunc(first ?? 1)), units)

	return { from: start, to: Math.min(Math.max(start, Math.trunc(last ?? first ?? start)), units) }
}

// "pages 3–7 of 41", "page 3 of 41", "slides 1–6 of 6"; a text reads "all".
export function documentRangeText(kind: AssistantDocumentKind, from: number, to: number, units: number): string {
	if (kind === "text") {
		return "all"
	}

	const words = DOCUMENT_UNIT_WORDS[kind]

	return from === to
		? `${words.one} ${String(from)} of ${String(units)}`
		: `${words.many} ${String(from)}–${String(to)} of ${String(units)}`
}

// A reader's text (its units one after the other, each starting at `start`) as document units numbered from `first`.
// The blank line a reader puts between units is not part of either.
export function splitDocumentText(
	{ text, units }: { readonly text: string; readonly units: readonly { readonly label: string; readonly start: number }[] },
	first: number
): AssistantDocumentUnit[] {
	return units.map(({ label, start }, index) => {
		const next = units[index + 1]

		return {
			unit: first + index,
			label,
			text: text.slice(start, next === undefined ? text.length : next.start).replace(/\n\n$/, "")
		}
	})
}

// What a read's extraction covered when it did not cover all that was asked: units `from` to `to` of `units`, the
// rest running to `end`. `to` below `from`: only part of the first unit.
export type AssistantDocumentCoverage = {
	kind: AssistantDocumentKind
	from: number
	to: number
	units: number
	end: number
}

// "pages 1–23 of 41", or "part of page 12 of 41".
export function documentCoveredText({ kind, from, to, units }: AssistantDocumentCoverage): string {
	return to < from ? `part of ${documentRangeText(kind, from, from, units)}` : documentRangeText(kind, from, to, units)
}

// Units as one text for an extraction: each under its label.
export function documentUnitsText(units: readonly AssistantDocumentUnit[]): string {
	return units.map(unit => `[${unit.label}]\n${unit.text}`).join("\n\n")
}

// A run of units one extraction reads in a chunked read: `first` to `last` (1-based in the document), the last
// read whole unless `whole` is false (a unit too long for one extraction goes in parts, "page 12 (part 2)").
export type AssistantDocumentChunk = {
	first: number
	last: number
	whole: boolean
	text: string
}

// The longest start of `chars` within `maxTokens`, at least one character.
function fittingChars(chars: readonly string[], maxTokens: number): number {
	let low = 1
	let high = chars.length

	while (low < high) {
		const middle = Math.ceil((low + high) / 2)

		if (estimateTokens(chars.slice(0, middle).join("")) <= maxTokens) {
			low = middle
		} else {
			high = middle - 1
		}
	}

	return low
}

// A unit's text in parts of at most `maxTokens`, cut at line ends where it can, else inside a line.
function unitParts(text: string, maxTokens: number): string[] {
	const parts: string[] = []
	let lines: string[] = []
	let tokens = 0

	const flush = () => {
		if (lines.length > 0) {
			parts.push(lines.join("\n"))
			lines = []
			tokens = 0
		}
	}

	for (const line of text.split("\n")) {
		const lineTokens = estimateTokens(line) + 1

		if (lineTokens > maxTokens) {
			flush()

			let rest = Array.from(line)

			while (rest.length > 0) {
				const cut = fittingChars(rest, maxTokens)

				parts.push(rest.slice(0, cut).join(""))
				rest = rest.slice(cut)
			}

			continue
		}

		if (tokens + lineTokens > maxTokens) {
			flush()
		}

		lines.push(line)
		tokens += lineTokens
	}

	flush()

	return parts
}

// Units packed in order into chunks of at most `maxTokens` each (as estimateTokens counts their labelled text), a
// unit too long for one alone split into parts of its own.
export function documentChunks(units: readonly AssistantDocumentUnit[], maxTokens: number): AssistantDocumentChunk[] {
	const chunks: AssistantDocumentChunk[] = []
	// The chunk being filled: empty or one.
	const open: { first: number; last: number; whole: boolean; pieces: string[]; tokens: number }[] = []

	const close = () => {
		const current = open.pop()

		if (current !== undefined) {
			chunks.push({ first: current.first, last: current.last, whole: current.whole, text: current.pieces.join("\n\n") })
		}
	}

	const add = (unit: number, piece: string, tokens: number, whole: boolean) => {
		const current = open[0]

		// A blank line joins two pieces.
		if (current === undefined || current.tokens + 1 + tokens > maxTokens) {
			close()
			open.push({ first: unit, last: unit, whole, pieces: [piece], tokens })

			return
		}

		current.pieces.push(piece)
		current.tokens += 1 + tokens
		current.last = unit
		current.whole = whole
	}

	for (const unit of units) {
		const piece = documentUnitsText([unit])
		const tokens = estimateTokens(piece)

		if (tokens <= maxTokens) {
			add(unit.unit, piece, tokens, true)

			continue
		}

		const parts = unitParts(unit.text, Math.max(1, maxTokens - estimateTokens(`[${unit.label} (part 999)]\n`)))

		for (const [index, part] of parts.entries()) {
			const labelled = `[${unit.label} (part ${String(index + 1)})]\n${part}`

			add(unit.unit, labelled, estimateTokens(labelled), index === parts.length - 1)
		}
	}

	close()

	return chunks
}

// Where the user is in the open document, as the context line says it.
export type AssistantOpenDocumentPosition = {
	readonly page?: number | undefined
	readonly pages?: number | undefined
	readonly sheet?: string | undefined
	readonly sheets?: readonly string[] | undefined
	readonly slide?: number | undefined
	readonly slides?: number | undefined
}

const KIND_LABELS: Readonly<Record<AssistantDocumentKind, string>> = {
	pdf: "PDF",
	docx: "Word document",
	sheet: "spreadsheet",
	slides: "presentation",
	text: "text"
}

function positionText(kind: AssistantDocumentKind, position: AssistantOpenDocumentPosition): string {
	const at = (word: string, current: number | undefined, total: number | undefined) =>
		current === undefined
			? ""
			: total === undefined
				? `, ${word} ${String(current)}`
				: `, ${word} ${String(current)} of ${String(total)}`

	switch (kind) {
		case "pdf":
		case "docx":
			return at("page", position.page, position.pages)
		case "slides":
			return at("slide", position.slide, position.slides)
		case "sheet": {
			if (position.sheet === undefined) {
				return ""
			}

			const index = position.sheets?.indexOf(position.sheet) ?? -1
			const of = index === -1 || position.sheets === undefined ? "" : ` (${String(index + 1)} of ${String(position.sheets.length)})`

			return `, sheet ${contextName(position.sheet)}${of}`
		}
		case "text":
			return ""
	}
}

// The context line's part for the open document: its name and handle (which ground a read of it), where the user is
// in it and how much is selected. Never the selected text: it may be someone else's, and the context line is not
// quarantined.
export function openDocumentContext({
	name,
	handle,
	kind,
	position,
	selectionChars
}: {
	name: string
	handle: string
	kind: AssistantDocumentKind
	position: AssistantOpenDocumentPosition
	selectionChars: number | null
}): string {
	const selected = selectionChars === null || selectionChars <= 0 ? "" : `, ${String(selectionChars)} characters selected`

	return `open document: ${contextName(name)} (handle ${handle}), ${KIND_LABELS[kind]}${positionText(kind, position)}${selected}`
}
