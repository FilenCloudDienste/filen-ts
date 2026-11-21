import type { DocumentText } from "@/lib/activeDocument"

// What a document reader (activeDocument.ts) builds its answer with: units (pages, sheets, slides) one after the
// other, a blank line between, cut at the characters asked for and never inside a surrogate pair.

const SEPARATOR = "\n\n"

// `range` clamped to 1..`units` (`to` at least `from`); null for a document without units.
export function unitRange(range: { readonly from: number; readonly to: number }, units: number): { from: number; to: number } | null {
	if (units < 1) {
		return null
	}

	const from = Math.min(Math.max(1, Math.trunc(range.from)), units)

	return { from, to: Math.min(Math.max(from, Math.trunc(range.to)), units) }
}

function cut(text: string, room: number): string {
	if (text.length <= room) {
		return text
	}

	const code = text.charCodeAt(room - 1)

	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? room - 1 : room)
}

export class DocumentTextBuilder {
	private readonly maxChars: number
	private readonly parts: string[] = []
	private readonly units: { label: string; start: number }[] = []
	private length = 0
	private cutShort = false

	constructor(maxChars: number) {
		this.maxChars = Math.max(0, Math.trunc(maxChars))
	}

	// What is left to fill.
	get room(): number {
		return this.cutShort ? 0 : Math.max(0, this.maxChars - this.length - (this.units.length === 0 ? 0 : SEPARATOR.length))
	}

	get full(): boolean {
		return this.cutShort
	}

	// Adds a unit; false once the text is full (this unit cut, or no room for it).
	add(label: string, text: string): boolean {
		if (this.cutShort) {
			return false
		}

		const room = this.room
		const separator = this.units.length === 0 ? "" : SEPARATOR

		// No room for even the separator, or none for a unit with text.
		if (this.length + separator.length > this.maxChars || (room === 0 && text.length > 0)) {
			this.cutShort = true

			return false
		}

		this.parts.push(separator)
		this.length += separator.length

		const kept = cut(text, room)

		this.units.push({ label, start: this.length })
		this.parts.push(kept)
		this.length += kept.length

		if (kept.length < text.length) {
			this.cutShort = true
		}

		return !this.cutShort
	}

	// The document has more than was read (the viewer does not hold it yet, or the engine cut it).
	truncate(): void {
		this.cutShort = true
	}

	result(): DocumentText {
		return { text: this.parts.join(""), units: this.units, truncated: this.cutShort }
	}
}
