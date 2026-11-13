// Filmstrip thumbnails by slot, least recently used dropped (and closed) past a byte budget, so zooming and panning back
// and forth reuse what was decoded instead of asking again, while memory stays bounded by what a tile really holds
// (RGBA, 4 bytes a pixel) rather than by a count of tiles of any size. The timeline sizes the budget to the visible
// slots. Once closed, the cache closes whatever still arrives (a fetch that outlived the timeline).
export class ThumbnailCache {
	private readonly entries = new Map<string, ImageBitmap>()
	private bytes = 0
	private budget: number
	private closed = false

	constructor(budgetBytes: number) {
		this.budget = budgetBytes
	}

	static key(step: number, time: number): string {
		return `${String(step)}:${String(time)}`
	}

	static sizeOf(bitmap: ImageBitmap): number {
		return bitmap.width * bitmap.height * 4
	}

	get size(): number {
		return this.bytes
	}

	setBudget(budgetBytes: number): void {
		this.budget = budgetBytes
		this.evict()
	}

	get(key: string): ImageBitmap | undefined {
		const bitmap = this.entries.get(key)

		if (bitmap !== undefined) {
			// Most recently used last.
			this.entries.delete(key)
			this.entries.set(key, bitmap)
		}

		return bitmap
	}

	has(key: string): boolean {
		return this.entries.has(key)
	}

	set(key: string, bitmap: ImageBitmap): void {
		if (this.closed) {
			bitmap.close()

			return
		}

		const previous = this.entries.get(key)

		if (previous !== undefined) {
			this.entries.delete(key)
			this.bytes -= ThumbnailCache.sizeOf(previous)

			if (previous !== bitmap) {
				previous.close()
			}
		}

		this.entries.set(key, bitmap)
		this.bytes += ThumbnailCache.sizeOf(bitmap)
		this.evict()
	}

	// Takes tiles again after clear() (the timeline mounted again).
	open(): void {
		this.closed = false
	}

	// Closes every tile; later arrivals are closed on arrival, until open().
	clear(): void {
		this.closed = true

		for (const bitmap of this.entries.values()) {
			bitmap.close()
		}

		this.entries.clear()
		this.bytes = 0
	}

	// The newest entry always stays, even alone over the budget: it is what is on screen.
	private evict(): void {
		while (this.bytes > this.budget && this.entries.size > 1) {
			const oldest = this.entries.keys().next()

			if (oldest.done === true) {
				break
			}

			const bitmap = this.entries.get(oldest.value)

			this.entries.delete(oldest.value)

			if (bitmap !== undefined) {
				this.bytes -= ThumbnailCache.sizeOf(bitmap)
				bitmap.close()
			}
		}
	}
}
