import { formatBytes } from "@filen/shared"
import { looksLikeText } from "@filen/shared/textEncoding"
import {
	DOCUMENT_NO_TEXT_NOTE,
	DOCUMENT_READ_MAX_CHARS,
	documentRangeText,
	documentReadRange,
	normalizeText,
	nothingSelected,
	readWithTextFile,
	splitDocumentText,
	type AssistantDocumentKind
} from "@filen/shared/assistant"
import { getActiveDocument, type ActiveDocument, type DocumentText, type UnitReader } from "@/lib/activeDocument"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { CATEGORY_POLICY, extensionOf, previewType } from "@/features/drive/lib/preview.logic"
import { spreadsheetFileKind } from "@/features/spreadsheet/lib/fileKind"
import { loadDriveFileBytes } from "@/features/preview/lib/fileBytes"
import { readTextFileDetected } from "@/features/preview/lib/encodingGuess"
import { textDocumentReader } from "@/features/preview/lib/documentReaders"
import { ClosedDocumentRefusal, closedDocumentKind, openClosedDocument } from "@/features/preview/lib/closedDocuments"
import {
	abortSignalOf,
	driveName,
	freshDriveItem,
	livePath,
	requiredString,
	resolveHandle,
	showDrive,
	type ToolAdapter
} from "@/features/assistant/tools/entities"
import { TEXT_FILE_MAX_BYTES } from "@/features/assistant/tools/drive"
import { AssistantToolError } from "@/features/assistant/tools/format"

// A closed document is downloaded whole and parsed once for a read; past this it is refused (the user can open it,
// and the open viewer's engine reads it without a download).
export const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024

// The open document's kind as read_document names it; a note is a text.
function documentKind(kind: ActiveDocument["kind"]): AssistantDocumentKind {
	return kind === "note" ? "text" : kind
}

// The open document, when `item` is it: its viewer's engine reads it, with nothing downloaded or parsed again.
function openDocumentOf(item: DriveItem): ActiveDocument | null {
	const open = getActiveDocument()

	return open !== null && !("note" in open.item) && open.item.data.uuid === item.data.uuid ? open : null
}

interface DocumentSource {
	kind: AssistantDocumentKind
	reader: UnitReader
	sheets: readonly string[] | undefined
	// Only the open document has a selection, read through its entry.
	open: ActiveDocument | null
	close: () => void
}

// A closed text-family file (text, code, markdown, CSV) as one unit, decoded like read_text_file.
async function closedTextSource(item: DriveItem, name: string, signal: AbortSignal): Promise<DocumentSource> {
	const bytes = await loadDriveFileBytes(item, signal, { cache: false })

	if (!looksLikeText(bytes)) {
		throw new AssistantToolError(`"${name}" is not a text file`)
	}

	const text = (await readTextFileDetected(bytes)).text

	return { kind: "text", reader: textDocumentReader(() => text), sheets: undefined, open: null, close: () => undefined }
}

async function closedSource(item: DriveItem, name: string, signal: AbortSignal): Promise<DocumentSource> {
	const type = previewType(item)

	if (type === "email" || type === "mailbox") {
		throw new AssistantToolError(`"${name}" is a message; read it with read_text_file`, { invalid: true })
	}

	if (item.data.size > BigInt(DOCUMENT_MAX_BYTES)) {
		throw new AssistantToolError(
			`"${name}" is too large to read unopened (${formatBytes(Number(item.data.size))}); the user can open it first`
		)
	}

	const kind = closedDocumentKind(item)

	if (kind !== null && typeof kind === "object") {
		throw new AssistantToolError(kind.refused)
	}

	if (kind === null) {
		const csv = spreadsheetFileKind(extensionOf(name).toLowerCase())

		if (!CATEGORY_POLICY[type].textFamily && csv !== "csv" && csv !== "tsv") {
			throw new AssistantToolError(`"${name}" is not a document this can read`)
		}

		// One lane per type: read_text_file reads text files, except one too large for it, which is read here in chunks.
		if (item.data.size <= TEXT_FILE_MAX_BYTES) {
			throw new AssistantToolError(readWithTextFile(name), { invalid: true })
		}

		return await closedTextSource(item, name, signal)
	}

	const bytes = await loadDriveFileBytes(item, signal, { cache: false })

	try {
		const opened = await openClosedDocument(item, bytes, kind, signal)

		return {
			kind,
			reader: opened.reader,
			sheets: opened.sheets,
			open: null,
			close: () => {
				opened.close()
			}
		}
	} catch (e) {
		if (e instanceof ClosedDocumentRefusal) {
			throw new AssistantToolError(e.message)
		}

		throw e
	}
}

// The unit a sheet name names: exact first, then folded.
function sheetUnit(sheets: readonly string[] | undefined, wanted: string): number | null {
	if (sheets === undefined) {
		return null
	}

	const exact = sheets.indexOf(wanted)

	if (exact !== -1) {
		return exact + 1
	}

	const folded = normalizeText(wanted)
	const index = sheets.findIndex(sheet => normalizeText(sheet) === folded)

	return index === -1 ? null : index + 1
}

async function readSource(source: DocumentSource, input: Record<string, unknown>, name: string, signal: AbortSignal) {
	const units = await source.reader.units()
	const wantedSheet = typeof input["sheet"] === "string" && input["sheet"].trim().length > 0 ? input["sheet"].trim() : undefined

	if (input["part"] === "selection") {
		const open = source.open
		const selected = open?.selection ?? null

		if (open === null || selected === null) {
			throw new AssistantToolError(nothingSelected(name, source.kind), { invalid: true })
		}

		const read = await open.reader.text("selection", signal, DOCUMENT_READ_MAX_CHARS)

		return { units, range: "the selection", read, first: 1 }
	}

	let span = documentReadRange(input, units) ?? { from: 1, to: Math.max(1, units) }

	if (wantedSheet !== undefined && source.kind === "sheet") {
		const unit = sheetUnit(source.sheets ?? source.open?.position.sheets, wantedSheet)

		if (unit === null) {
			throw new AssistantToolError(`"${name}" has no sheet named "${wantedSheet}"`)
		}

		span = { from: unit, to: unit }
	}

	const read: DocumentText =
		units < 1 ? { text: "", units: [], truncated: false } : await source.reader.text(span, signal, DOCUMENT_READ_MAX_CHARS)

	return { units, range: documentRangeText(source.kind, span.from, span.to, units), read, first: span.from }
}

// read_document: the open document through its viewer's engine, any other through a one-off headless read of its
// bytes, which neither stays in nor evicts the preview cache. The text goes out as units (documents.ts), all of it
// for the content extraction.
export const readDocumentTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["drive"])

	if (entity.kind !== "drive") {
		throw new AssistantToolError("Not a document", { invalid: true })
	}

	const item = freshDriveItem(entity.item)
	const name = driveName(item)

	if (isDirectoryItem(item)) {
		throw new AssistantToolError(`"${name}" is a directory, not a document`, { invalid: true })
	}

	if (item.data.undecryptable) {
		throw new AssistantToolError("This file cannot be decrypted")
	}

	const signal = abortSignalOf(scope.signal) ?? new AbortController().signal
	const open = openDocumentOf(item)

	// An open text file's selection is read here; the file itself by read_text_file, unless it is too large for that.
	if (open !== null && documentKind(open.kind) === "text" && input["part"] !== "selection" && item.data.size <= TEXT_FILE_MAX_BYTES) {
		throw new AssistantToolError(readWithTextFile(name), { invalid: true })
	}

	const source: DocumentSource =
		open === null
			? await closedSource(item, name, signal)
			: { kind: documentKind(open.kind), reader: open.reader, sheets: open.position.sheets, open, close: () => undefined }

	try {
		const { units, range, read, first } = await readSource(source, input, name, signal)
		const content = splitDocumentText(read, first)
		const empty = content.every(unit => unit.text.trim().length === 0)

		return {
			value: {
				handle: showDrive(scope, item, livePath(entity, item)),
				name,
				kind: source.kind,
				units,
				range,
				...(empty ? { content: "", note: DOCUMENT_NO_TEXT_NOTE } : { content }),
				...(read.truncated ? { truncated: true } : {})
			}
		}
	} finally {
		source.close()
	}
}
