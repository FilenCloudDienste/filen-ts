// Decoded frames kept for going back to them, least recently used out first, within a byte cap. The frame on screen is
// held by the viewer itself, so a frame larger than the cap is simply not kept.

export class FrameCache<T> {
	private readonly entries = new Map<number, { readonly value: T; readonly bytes: number }>()
	private total = 0
	private readonly cap: number

	constructor(cap: number) {
		this.cap = cap
	}

	get(index: number): T | undefined {
		const entry = this.entries.get(index)

		if (entry === undefined) return undefined

		// Most recent last.
		this.entries.delete(index)
		this.entries.set(index, entry)

		return entry.value
	}

	set(index: number, value: T, bytes: number): void {
		const previous = this.entries.get(index)

		if (previous !== undefined) {
			this.entries.delete(index)
			this.total -= previous.bytes
		}

		if (bytes > this.cap) return

		this.entries.set(index, { value, bytes })
		this.total += bytes

		for (const [key, entry] of this.entries) {
			if (this.total <= this.cap) break

			this.entries.delete(key)
			this.total -= entry.bytes
		}
	}

	get bytes(): number {
		return this.total
	}

	clear(): void {
		this.entries.clear()
		this.total = 0
	}
}
