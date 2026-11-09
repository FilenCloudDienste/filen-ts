import type { SheetRange, SheetSelectionStats } from "@filen/office/core/sheet"

// The status bar's summary (Excel's "View summary data on the status bar"): nothing for one cell or for fewer than
// two that hold something; Count of those that do, and Average and Sum when they hold numbers and no error.
export interface StatusSummary {
	readonly count: number
	readonly average: string | null
	readonly sum: string | null
}

export function statusSummary(stats: SheetSelectionStats | null): StatusSummary | null {
	if (stats === null || stats.count < 2) {
		return null
	}

	const numbers = stats.numericCount > 0 && !stats.error

	return { count: stats.count, average: numbers ? stats.average : null, sum: numbers ? stats.sum : null }
}

// One cell selected (a merge's range included): the bar shows nothing, and nothing is asked.
export function singleCell(ranges: readonly SheetRange[]): boolean {
	if (ranges.length !== 1) {
		return false
	}

	const range = ranges[0]

	return range !== undefined && range.startRow === range.endRow && range.startCol === range.endCol
}

// Asks for the latest request only: while one answer is out, newer requests replace each other, and the last is
// asked once that answer is in (a selection dragged over a large sheet queues no walk per move). An answer is
// delivered only while it answers the latest request.
export class LatestQuery<Q, R> {
	private readonly run: (request: Q) => Promise<R>
	private readonly deliver: (result: R) => void
	private inFlight = false
	private pending: { readonly request: Q } | null = null
	private latest = 0

	constructor(run: (request: Q) => Promise<R>, deliver: (result: R) => void) {
		this.run = run
		this.deliver = deliver
	}

	request(request: Q): void {
		this.latest++

		if (this.inFlight) {
			this.pending = { request }

			return
		}

		this.start(request)
	}

	// Drops any answer still out, and the request waiting behind it.
	cancel(): void {
		this.latest++
		this.pending = null
	}

	private start(request: Q): void {
		const asked = this.latest

		this.inFlight = true

		const settle = (): void => {
			this.inFlight = false

			const next = this.pending

			this.pending = null

			if (next !== null) {
				this.start(next.request)
			}
		}

		this.run(request).then(
			result => {
				if (asked === this.latest) {
					this.deliver(result)
				}

				settle()
			},
			() => {
				settle()
			}
		)
	}
}
