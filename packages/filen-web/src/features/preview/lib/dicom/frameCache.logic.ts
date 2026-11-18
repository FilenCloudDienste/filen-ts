// Decoded frames kept for coming back to them, within a byte cap: a window about the frame on screen, not the frames
// used last. While cine plays, the frames kept are the next ones to be shown in play order, so a loop longer than the
// cap still finds the frames ahead of it (the ones just shown are the furthest from being shown again, and go first);
// stepping, the frames nearest the one on screen either way are kept. A frame further than every frame kept is not
// kept at all, and neither is one larger than the cap (the viewer holds the frame on screen itself).

export class FrameCache<T> {
	private readonly entries = new Map<number, { readonly value: T; readonly bytes: number }>()
	private total = 0
	private readonly cap: number
	private at = 0
	private frames = 1
	private forward = false

	constructor(cap: number) {
		this.cap = cap
	}

	// The frame on screen, of `frames`, and whether cine is playing forward from it.
	anchor(index: number, frames: number, playing: boolean): void {
		this.at = index
		this.frames = Math.max(1, frames)
		this.forward = playing
	}

	// How far frame `index` is from being shown: frames ahead in play order while playing, else either way.
	private distance(index: number): number {
		const ahead = (((index - this.at) % this.frames) + this.frames) % this.frames

		return this.forward ? ahead : Math.abs(index - this.at)
	}

	get(index: number): T | undefined {
		return this.entries.get(index)?.value
	}

	has(index: number): boolean {
		return this.entries.has(index)
	}

	// Whether a frame of `bytes` at `index` would be kept: within the cap, and nearer than a frame it would replace.
	keeps(index: number, bytes: number): boolean {
		if (bytes > this.cap) return false
		if (this.total + bytes <= this.cap) return true

		for (const key of this.entries.keys()) {
			if (this.distance(key) > this.distance(index)) return true
		}

		return false
	}

	set(index: number, value: T, bytes: number): void {
		const previous = this.entries.get(index)

		if (previous !== undefined) {
			this.entries.delete(index)
			this.total -= previous.bytes
		}

		if (bytes > this.cap) return

		while (this.total + bytes > this.cap) {
			let furthest: number | null = null

			for (const key of this.entries.keys()) {
				if (furthest === null || this.distance(key) > this.distance(furthest)) furthest = key
			}

			// The new frame is the furthest of all: it is the one not kept.
			if (furthest === null || this.distance(furthest) <= this.distance(index)) return

			this.total -= this.entries.get(furthest)?.bytes ?? 0
			this.entries.delete(furthest)
		}

		this.entries.set(index, { value, bytes })
		this.total += bytes
	}

	get bytes(): number {
		return this.total
	}

	clear(): void {
		this.entries.clear()
		this.total = 0
	}
}
