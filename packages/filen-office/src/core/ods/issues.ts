// What an OpenDocument spreadsheet holds that the view does not show as LibreOffice does, each with a typed reason:
// shown approximately, or kept aside (its cached result or text shown instead). Nothing is dropped unnamed.
export type OdsIssueKind =
	// Shapes, images, charts and frames (table:shapes, draw:* in cells): not drawn.
	| "drawing"
	// A formula not carried into the engine's grammar: its cached result is shown (detail: why).
	| "formula"
	// A data style part a number format code cannot say (detail: which); the rest is shown.
	| "dataStyle"
	| "rotation"
	| "pivotTable"
	| "scenario"
	| "linkedSheet"
	| "form"
	| "ddeLink"
	| "consolidation"
	| "labelRanges"
	| "trackedChanges"
	| "subTable"
	| "detective"
	| "cellRangeSource"
	// A rule the conditional formats, validations or filters cannot show (detail: which).
	| "conditionalFormat"
	| "validation"
	| "filter"
	// A second link in one cell: the first is the cell's.
	| "link"
	// A named expression not carried into the engine's grammar.
	| "name"
	// The workbook's null date is neither 1899-12-30 nor 1904-01-01: date cells keep their dates, but float serials
	// and formulas computing on the file's own origin are taken on the 1899-12-30 base.
	| "nullDate"
	// Cells or rows repeated past what is materialised: the rest of the run is not shown (detail: how many).
	| "repeat"
	// A language whose separators the formatter does not have: the app's are shown.
	| "locale"

export interface OdsIssue {
	readonly kind: OdsIssueKind
	readonly sheet: string | undefined
	readonly detail: string | undefined
	readonly count: number
}

// Distinct issues kept; past this, counts grow on the ones there.
const MAX_ISSUES = 256

export class OdsIssues {
	private readonly byKey = new Map<string, { kind: OdsIssueKind; sheet: string | undefined; detail: string | undefined; count: number }>()

	add(kind: OdsIssueKind, sheet: string | undefined, detail?: string, count = 1): void {
		const key = `${kind}\u0000${sheet ?? ""}\u0000${detail ?? ""}`
		const found = this.byKey.get(key)

		if (found !== undefined) {
			found.count += count

			return
		}

		if (this.byKey.size >= MAX_ISSUES) {
			const any = this.byKey.get(`${kind}\u0000\u0000overflow`)

			if (any !== undefined) any.count += count
			else this.byKey.set(`${kind}\u0000\u0000overflow`, { kind, sheet: undefined, detail: "overflow", count })

			return
		}

		this.byKey.set(key, { kind, sheet, detail: detail === undefined ? undefined : detail.slice(0, 200), count })
	}

	list(): OdsIssue[] {
		return [...this.byKey.values()].map(issue => ({ ...issue }))
	}
}
