// Page thumbnails for the pages rail and the Organise grid. The rail says which pages it has mounted (in view first,
// then the overscan nearest first); only those keep a bitmap: every other one is closed at once, and a render for a
// page that left the window is aborted. So at most the rail's window (rows in view + 2 × overscan) holds bitmaps,
// whatever the document's length. Renders run one at a time in the window's order through the host's renderer (the
// engine's "thumbnail" priority, below visible page tiles). Keyed by page id, so a moved page keeps its bitmap.

export interface ThumbnailBitmap {
	readonly width: number
	readonly height: number
	close(): void
}

// Renders page `page` (0-based) `widthPx` device pixels wide; rejects (or resolves late) after `signal` aborts.
export type RenderThumbnail = (page: number, widthPx: number, signal: AbortSignal) => Promise<ThumbnailBitmap>

interface Entry {
	bitmap: ThumbnailBitmap | undefined
	width: number
}

export class PageThumbnails {
	private render: RenderThumbnail
	private readonly onChange: () => void
	private readonly entries = new Map<string, Entry>()
	private queue: { readonly id: string; readonly page: number }[] = []
	private width = 0
	private running: { readonly id: string; readonly page: number; readonly controller: AbortController } | undefined = undefined
	private disposed = false
	// Bumped on every change, for useSyncExternalStore.
	version = 0

	constructor(render: RenderThumbnail, onChange: () => void) {
		this.render = render
		this.onChange = onChange
	}

	// The host's renderer, when it changes (the engine restarted): later renders use it.
	setRenderer(render: RenderThumbnail): void {
		this.render = render
	}

	get(id: string): ThumbnailBitmap | undefined {
		return this.entries.get(id)?.bitmap
	}

	// The pages mounted, by id and current index, in priority order, and the width wanted.
	setWindow(pages: readonly { readonly id: string; readonly page: number }[], widthPx: number): void {
		const width = Math.max(1, Math.round(widthPx))
		const wanted = new Map(pages.map(page => [page.id, page.page]))
		let changed = false

		this.disposed = false
		this.width = width

		for (const [id, entry] of this.entries) {
			if (!wanted.has(id)) {
				entry.bitmap?.close()
				this.entries.delete(id)
				changed = true
			}
		}

		// A render for a page that left the window, or that moved (its index now draws another page), stops.
		if (this.running !== undefined && wanted.get(this.running.id) !== this.running.page) this.running.controller.abort()

		this.queue = pages.filter(page => {
			const entry = this.entries.get(page.id)

			return entry?.bitmap === undefined || entry.width !== width
		})

		if (changed) this.bump()

		this.pump()
	}

	// Pages whose look changed (rotated, cropped, edited): drawn again when next in the window.
	invalidate(ids: Iterable<string>): void {
		let changed = false

		for (const id of ids) {
			const entry = this.entries.get(id)

			if (entry !== undefined) {
				entry.bitmap?.close()
				this.entries.delete(id)
				changed = true
			}

			if (this.running?.id === id) this.running.controller.abort()
		}

		if (changed) this.bump()
	}

	// Closes every bitmap and stops the render; a later setWindow (the rail mounted again) starts over.
	dispose(): void {
		this.disposed = true
		this.running?.controller.abort()
		this.queue = []

		for (const entry of this.entries.values()) entry.bitmap?.close()

		this.entries.clear()
	}

	private bump(): void {
		this.version++
		this.onChange()
	}

	private pump(): void {
		if (this.running !== undefined || this.disposed) return

		const next = this.queue.shift()

		if (next === undefined) return

		const controller = new AbortController()
		const width = this.width

		this.running = { id: next.id, page: next.page, controller }
		this.render(next.page, width, controller.signal).then(
			bitmap => {
				this.running = undefined

				if (controller.signal.aborted || this.disposed) bitmap.close()
				else {
					this.entries.get(next.id)?.bitmap?.close()
					this.entries.set(next.id, { bitmap, width })
					this.bump()
				}

				this.pump()
			},
			() => {
				this.running = undefined
				this.pump()
			}
		)
	}
}
