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

// How sparing a rail is with a document pdf.js reads in ranges, where every thumbnail reads and decodes its page:
// `current` is the page shown, `explored` true once the user scrolled or moved through the rail.
export interface ThumbnailSparing {
	readonly current: number
	readonly explored: boolean
}

// Pages within this distance of the page shown get thumbnails before the rail is explored: the view reads them anyway.
const SPARING_NEIGHBOURS = 1

// The pages a rail asks thumbnails for, from its mounted `indices` (the `inView` ones first): all of them, or with
// `sparing` the ones in view only, and until the rail is explored only those next to the page shown.
export function thumbnailWindow(indices: readonly number[], inView: number, sparing: ThumbnailSparing | null): readonly number[] {
	if (sparing === null) return indices

	const shown = indices.slice(0, Math.max(0, inView))

	return sparing.explored ? shown : shown.filter(index => Math.abs(index - sparing.current) <= SPARING_NEIGHBOURS)
}

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
	private running:
		{ readonly id: string; readonly page: number; readonly width: number; readonly controller: AbortController } | undefined = undefined
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

		// The page being rendered stays out of the queue while its render still counts (not aborted, same width): queued
		// again, it would be drawn twice.
		const running =
			this.running !== undefined && !this.running.controller.signal.aborted && this.running.width === width ? this.running : undefined

		this.queue = pages.filter(page => {
			if (page.id === running?.id) return false

			return !this.drawn(page.id, width)
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

			// The render in flight draws the old look: it stops and the page goes back to the front of the queue, so it is
			// drawn again without waiting for the next window. One setWindow already aborted is queued by setWindow itself.
			if (this.running?.id === id && !this.running.controller.signal.aborted) {
				const page = this.running.page

				this.running.controller.abort()

				if (!this.queue.some(item => item.id === id)) this.queue.unshift({ id, page })
			}
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

	private drawn(id: string, width: number): boolean {
		const entry = this.entries.get(id)

		return entry?.bitmap !== undefined && entry.width === width
	}

	private pump(): void {
		if (this.running !== undefined || this.disposed) return

		const width = this.width
		let next = this.queue.shift()

		// A page that already holds a bitmap at this width needs no render.
		while (next !== undefined && this.drawn(next.id, width)) next = this.queue.shift()

		if (next === undefined) return

		const controller = new AbortController()

		this.running = { id: next.id, page: next.page, width, controller }
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
