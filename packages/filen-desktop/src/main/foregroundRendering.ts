// What a page's foreground-rendering holds need of its webContents.
export interface ThrottlingContents {
	readonly id: number
	isDestroyed(): boolean
	getBackgroundThrottling(): boolean
	setBackgroundThrottling(allowed: boolean): void
}

export interface ForegroundRendering {
	// The page's hold count (lib/desktop.ts holdForegroundRendering): while above 0 its window renders at full rate
	// when hidden or occluded; at 0 the throttling it was created with is back.
	setHolds(contents: ThrottlingContents, count: number): void
	// A new document, a crashed renderer or closed contents: the old page's holds go with it.
	pageGone(contentsId: number): void
}

export function createForegroundRendering(): ForegroundRendering {
	// Only contents with holds, with the throttling they had before the first one.
	const holders = new Map<number, { contents: ThrottlingContents; original: boolean }>()

	function release(contentsId: number): void {
		const entry = holders.get(contentsId)

		if (entry === undefined) {
			return
		}

		holders.delete(contentsId)

		if (!entry.contents.isDestroyed()) {
			entry.contents.setBackgroundThrottling(entry.original)
		}
	}

	return {
		setHolds: (contents, count) => {
			if (count === 0) {
				release(contents.id)

				return
			}

			if (holders.has(contents.id) || contents.isDestroyed()) {
				return
			}

			holders.set(contents.id, { contents, original: contents.getBackgroundThrottling() })
			contents.setBackgroundThrottling(false)
		},
		pageGone: release
	}
}
