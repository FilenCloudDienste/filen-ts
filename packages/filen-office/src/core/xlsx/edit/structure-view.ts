import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import type { XlsxSheetModel, XlsxSheetView, XlsxWorkbookModel } from "../model/types"
import { refState } from "../refs/state"
import { writeSheetViews } from "../write/sections"

// A sheet's first view changed by an edit (frozen panes, the selected tab): written as the catalogue holds the
// views when it rewrote them (every other view and pane as it left them), else through the model's own writer.
// Returns what puts the view back.
export function setSheetView(workbook: XlsxWorkbookModel, model: XlsxSheetModel, view: XlsxSheetView): () => void {
	const before = model.view
	const state = refState(workbook)
	const marked = workbook.changes.sheets.get(model.id)?.sections

	if (marked?.has("sheetViews") === true && !state.ownsSection(marked.get("sheetViews"))) {
		model.view = view
		workbook.changes.sheetSection(model.id, "sheetViews")

		return () => {
			model.view = before
		}
	}

	const markup = state.sectionMarkup(model, "sheetViews")
	const prefix = model.prefix
	const current = markup.length === 0 ? null : encodeUtf8(markup.join(""))
	const written = writeSheetViews(view, current, prefix)

	if (written === current) {
		model.view = view

		return () => {
			model.view = before
		}
	}

	state.setSection(model, "sheetViews", [decodeUtf8(written)])
	model.view = view

	return () => {
		state.setSection(model, "sheetViews", markup)
		model.view = before
	}
}
