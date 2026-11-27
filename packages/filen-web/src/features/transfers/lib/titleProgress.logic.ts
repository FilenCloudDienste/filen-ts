// The overall percent of the running transfers in the tab's title while the tab is hidden, so it reads from the tab
// strip. The title is written only when the whole percent changes, and put back once the tab shows or nothing runs.

export interface TitleDocument {
	title: string
	readonly hidden: boolean
}

export interface TitleProgress {
	// 0-100 over the running transfers, null when none runs.
	update: (percent: number | null) => void
}

export function titleProgress(doc: TitleDocument, format: (percent: number, title: string) => string): TitleProgress {
	// The title before ours, while ours shows, and the one we wrote.
	let base: string | null = null
	let written: string | null = null
	let shown: number | null = null

	function restore(): void {
		// A title written meanwhile by someone else (a route's head) is theirs to keep.
		if (base !== null && doc.title === written) {
			doc.title = base
		}

		base = null
		written = null
		shown = null
	}

	return {
		update: percent => {
			if (percent === null || !doc.hidden) {
				restore()

				return
			}

			const whole = Math.min(100, Math.max(0, Math.floor(percent)))

			if (base !== null && doc.title !== written) {
				base = doc.title
				shown = null
			}

			if (whole === shown) {
				return
			}

			base ??= doc.title
			written = format(whole, base)
			shown = whole
			doc.title = written
		}
	}
}
