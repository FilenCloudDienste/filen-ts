// The status bar's summary of a selection (Excel's "View summary data on the status bar"): Count of its cells that
// hold something, and the Sum and Average of its numbers, each cell of each range once (overlapping ranges count
// twice, as Excel's do). Hidden rows and columns are left out, as Excel's status bar leaves them. One walk over the
// cells a sheet holds, never over the empty ones a range covers.

declare module "../protocol" {
	interface SheetQueryMap {
		selectionStats: {
			request: { readonly sheet: SheetId; readonly ranges: readonly SheetRange[] }
			result: SheetSelectionStats
		}
	}
}

export interface SheetSelectionStats {
	// Cells that hold something (COUNTA).
	readonly count: number
	// Cells that hold a number (a date and a formula's numeric result are numbers).
	readonly numericCount: number
	// Sum and Average as the first number's cell format shows them; "" without numbers or with an error.
	readonly sum: string
	readonly average: string
	// A cell shows an error: Excel shows no Sum or Average then.
	readonly error: boolean
	// The session's version the answer reflects.
	readonly version: number
}

// Folds cells into a summary; `format` shows a number as the first number's cell shows it.
export class SelectionStatsTally<F> {
	count = 0
	numericCount = 0
	sum = 0
	error = false
	format: F | undefined = undefined

	text(): void {
		this.count++
	}

	number(value: number, format: F): void {
		this.count++
		this.numericCount++
		this.sum += value

		if (this.format === undefined) this.format = format
	}

	fail(): void {
		this.count++
		this.error = true
	}

	result(show: (format: F | undefined, value: number) => string, version: number): SheetSelectionStats {
		const shown = this.numericCount > 0 && !this.error

		return {
			count: this.count,
			numericCount: this.numericCount,
			sum: shown ? show(this.format, this.sum) : "",
			average: shown ? show(this.format, this.sum / this.numericCount) : "",
			error: this.error,
			version
		}
	}
}
