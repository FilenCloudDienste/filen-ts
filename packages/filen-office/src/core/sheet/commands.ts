import type { ByteSource } from "../opc/io"
import { openXlsx, sheetOpenFailure, XlsxReadError } from "../xlsx/read/index"
import { XlsxDocument } from "../xlsx/edit/document"
import { clearCells, setCells } from "../xlsx/edit/cells"
import { copyCells, pasteCells } from "../xlsx/edit/clipboard"
import { applyFormat } from "../xlsx/edit/format"
import { notesFeature } from "../xlsx/comments/feature"
import { linksFeature } from "../xlsx/hyperlinks/feature"
import { threadsFeature } from "../xlsx/threaded/feature"
import { filterFeature, visibleSelection } from "../xlsx/edit/filter"
import { formattingFeature } from "../xlsx/edit/formatFeature"
import { fitSample, resizeAxis } from "../xlsx/edit/resize"
import { sortFeature } from "../xlsx/edit/sort"
import { addSheet, moveAxis, renameSheet } from "../xlsx/edit/structure-basic"
import { STRUCTURE_FEATURES } from "../xlsx/edit/structure-features"
import type { SheetEvent, SheetOpenFailure, SheetOpened, SheetSessionOptions } from "./protocol"
import { conditionalFormattingFeature } from "./cf/xlsx"
import { xlsxClipboardHtmlFeature } from "./clipboard/xlsx"
import { dataValidationFeature } from "./dv/xlsx"
import { xlsxFillFeature } from "./fill/xlsx"
import { xlsxFindFeature } from "./find/xlsx"
import { xlsxAutoSumFeature } from "./functions/autoSumXlsx"
import { xlsxAutoCompleteFeature } from "./autoComplete/xlsx"
import { xlsxNavigateFeature } from "./navigate/xlsx"
import { xlsxSelectionStatsFeature } from "./stats/xlsx"
import { xlsxPrintFeature } from "./print/xlsx"
import { digitWidthFeature } from "../xlsx/edit/digitWidth"
import { namesFeature } from "../xlsx/edit/names"
import { chartsFeature } from "../xlsx/charts/feature"
import { drawingsFeature } from "../xlsx/drawings/feature"
import { saveAsFormatFeature } from "../ods/convert/feature"
import { defineSheetFeature, sheetRegistry, type SheetFeature } from "./registry"
import { RenderStyleTable, SheetSession, sessionFeature } from "./session"

// The xlsx session's own features (cells, formats, sizes, rows and columns, sheets, the clipboard) and the open
// that puts a session together. Later features join the list in their own modules.

export const cellsFeature = defineSheetFeature<XlsxDocument>({
	id: "cells",
	commands: {
		"cells.set": {
			info: { write: true },
			run: (context, command) =>
				setCells(context.doc, command.sheet, { ...command.cells, typed: true }, context.changes, undefined, context.slicing)
		},
		"cells.clear": {
			info: { write: true },
			run: async (context, command) =>
				clearCells(
					context.doc,
					command.sheet,
					await visibleSelection(context.doc, command.sheet, command.ranges),
					command.what,
					context.changes,
					context.slicing
				)
		}
	}
})

export const formatFeature = defineSheetFeature<XlsxDocument>({
	id: "format",
	commands: {
		"format.apply": {
			info: { write: true, protection: "formatCells" },
			run: async (context, command) =>
				applyFormat(
					context.doc,
					command.sheet,
					await visibleSelection(context.doc, command.sheet, command.ranges),
					command.patch,
					context.changes,
					context.slicing
				)
		}
	}
})

export const axisFeature = defineSheetFeature<XlsxDocument>({
	id: "axis",
	commands: {
		"axis.insert": {
			info: { write: true },
			run: (context, command) =>
				moveAxis(context.doc, command.sheet, command.axis, "insert", command.at, command.count, context.changes, context.slicing)
		},
		"axis.delete": {
			info: { write: true },
			run: (context, command) =>
				moveAxis(context.doc, command.sheet, command.axis, "delete", command.at, command.count, context.changes, context.slicing)
		},
		"axis.resize": {
			info: { write: true },
			run: (context, command) => {
				const refusal = context.doc.protects(command.sheet, command.axis === "rows" ? "formatRows" : "formatColumns")

				return refusal !== null
					? { refused: refusal }
					: resizeAxis(context.doc, command.sheet, command.axis, command.indices, command.sizes, context.changes)
			}
		}
	},
	queries: {
		fitSample: { run: (context, request) => fitSample(context.doc, request.sheet, request.axis, request.index, request.limit) }
	}
})

export const sheetsFeature = defineSheetFeature<XlsxDocument>({
	id: "sheets",
	commands: {
		"sheet.add": {
			info: { write: true, structure: true },
			run: (context, command) => addSheet(context.doc, command.name, command.index, context.changes, context.slicing)
		},
		"sheet.rename": {
			info: { write: true, structure: true },
			run: (context, command) => renameSheet(context.doc, command.sheet, command.name, context.changes, context.slicing)
		}
	}
})

export const clipboardFeature = defineSheetFeature<XlsxDocument>({
	id: "clipboard",
	commands: {
		"clipboard.paste": {
			info: { write: true },
			run: (context, command) =>
				pasteCells(
					context.doc,
					command.sheet,
					command.at,
					command.text,
					command.clip,
					context.changes,
					context.slicing,
					command.values === true,
					command.target
				)
		}
	},
	queries: {
		copy: { run: (context, request) => copyCells(context.doc, request.sheet, request.range, request.cut) }
	}
})

export const XLSX_FEATURES: readonly SheetFeature<XlsxDocument>[] = [
	cellsFeature,
	formatFeature,
	formattingFeature,
	axisFeature,
	sheetsFeature,
	clipboardFeature,
	...STRUCTURE_FEATURES,
	xlsxFindFeature,
	xlsxNavigateFeature,
	xlsxSelectionStatsFeature,
	xlsxAutoSumFeature,
	xlsxAutoCompleteFeature,
	xlsxPrintFeature,
	digitWidthFeature,
	namesFeature,
	drawingsFeature,
	chartsFeature,
	xlsxFillFeature,
	xlsxClipboardHtmlFeature,
	notesFeature,
	threadsFeature,
	linksFeature,
	sortFeature,
	filterFeature,
	dataValidationFeature,
	saveAsFormatFeature,
	// Last: a rule's look goes over what the features before it gave the cell.
	conditionalFormattingFeature
]

export type XlsxSessionOpen =
	| ({ readonly kind: "opened" } & SheetOpened & { readonly session: SheetSession<XlsxDocument> })
	| { readonly kind: "failed"; readonly reason: SheetOpenFailure; readonly message: string }
	| { readonly kind: "aborted" }

// Opens an xlsx (or its decrypted package) as a session: the package read, the active sheet parsed, the rest in
// idle slices. `features` adds to the base list.
export async function openXlsxSession(
	source: ByteSource,
	options: SheetSessionOptions,
	onEvent: (event: SheetEvent) => void,
	features: readonly SheetFeature<XlsxDocument>[] = []
): Promise<XlsxSessionOpen> {
	const opened = await openXlsx(source, {
		...(options.slicing !== undefined && { slicing: options.slicing }),
		...(options.signal !== undefined && { signal: options.signal })
	})

	if (!opened.ok) {
		if (opened.reason === "aborted") return { kind: "aborted" }

		return {
			kind: "failed",
			reason: opened.reason === "encrypted" || opened.reason === "legacyBinary" ? "unsupported" : sheetOpenFailure(opened.reason),
			message: opened.message
		}
	}

	const styles = new RenderStyleTable()
	const document = new XlsxDocument(opened.workbook, styles, {
		kind: options.kind,
		...(options.settings !== undefined && { settings: options.settings }),
		...(options.writeUnlocked !== undefined && { writeUnlocked: options.writeUnlocked }),
		...(options.encryption !== undefined && { encryption: options.encryption })
	})
	const session = new SheetSession(
		document,
		styles,
		{ features: own => sheetRegistry([...XLSX_FEATURES, ...features, sessionFeature(own)]) },
		options,
		onEvent
	)

	try {
		const info = await session.start(options.signal)

		return { kind: "opened", session, info }
	} catch (error) {
		session.close()

		if (error instanceof XlsxReadError) {
			if (error.code === "aborted") return { kind: "aborted" }

			return { kind: "failed", reason: error.code === "tooLarge" ? "tooLarge" : "malformed", message: error.message }
		}

		throw error
	}
}
