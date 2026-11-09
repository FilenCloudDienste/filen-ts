import { copyHtml, pasteHtml } from "../../xlsx/edit/clipboard"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { defineSheetFeature } from "../registry"

// Clipboard HTML over a workbook: a copy's table with values, formulas and formats (html.ts), and a paste of one.

export const xlsxClipboardHtmlFeature = defineSheetFeature<XlsxDocument>({
	id: "clipboardHtml",
	commands: {
		"clipboard.pasteHtml": {
			info: { write: true },
			run: (context, command) =>
				pasteHtml(
					context.doc,
					command.sheet,
					command.at,
					command.html,
					command.text,
					command.clip,
					context.changes,
					context.slicing,
					command.target
				)
		}
	},
	queries: {
		copyHtml: { run: (context, request) => copyHtml(context.doc, request.sheet, request.range, request.cut === true) }
	}
})
