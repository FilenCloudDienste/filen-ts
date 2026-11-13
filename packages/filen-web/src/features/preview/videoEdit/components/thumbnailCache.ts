// Filmstrip thumbnails by slot, oldest dropped (and closed) past `capacity`, so zooming and panning back and forth reuse
// what was decoded instead of asking again, while memory stays bounded.
export class ThumbnailCache {
	private readonly entries = new Map<string, ImageBitmap>()

	private readonly capacity: number

	constructor(capacity: number) {
		this.capacity = capacity
	}

	static key(step: number, time: number): string {
		return `${String(step)}:${String(time)}`
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
		const previous = this.entries.get(key)

		if (previous !== undefined && previous !== bitmap) {
			previous.close()
		}

		this.entries.delete(key)
		this.entries.set(key, bitmap)

		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next()

			if (oldest.done === true) {
				break
			}

			this.entries.get(oldest.value)?.close()
			this.entries.delete(oldest.value)
		}
	}

	clear(): void {
		for (const bitmap of this.entries.values()) {
			bitmap.close()
		}

		this.entries.clear()
	}
}
