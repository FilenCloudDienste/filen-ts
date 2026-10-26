import type { MetafileConversion } from "./types"

// Converted metafiles kept per document (equations and logos repeat their pictures across pages and slides), least
// recently used out first, bounded by count and by the bytes their lists and embedded bitmaps hold. A conversion
// larger than the whole budget is not kept.

export const MAX_CACHED_METAFILES = 48
export const MAX_CACHED_METAFILE_BYTES = 32 * 1024 * 1024

export function conversionBytes(conversion: MetafileConversion | undefined): number {
	if (conversion === undefined || !conversion.ok) return 0

	const list = conversion.list
	let bytes = list.commands.byteLength + list.coords.byteLength + list.itemFloats.byteLength + list.itemInts.byteLength

	for (const image of list.images) bytes += image.bytes?.byteLength ?? 0

	return bytes
}

export class MetafileCache {
	// Part name -> its conversion, oldest first.
	private readonly entries = new Map<string, { conversion: Promise<MetafileConversion | undefined>; bytes: number }>()
	private bytes = 0
	private readonly load: (partName: string) => Promise<MetafileConversion | undefined>

	constructor(load: (partName: string) => Promise<MetafileConversion | undefined>) {
		this.load = load
	}

	get(partName: string | undefined): Promise<MetafileConversion | undefined> {
		if (partName === undefined) return Promise.resolve(undefined)

		const cached = this.entries.get(partName)

		if (cached !== undefined) {
			// A hit moves to the end.
			this.entries.delete(partName)
			this.entries.set(partName, cached)

			return cached.conversion
		}

		const entry = { conversion: this.load(partName), bytes: 0 }

		this.entries.set(partName, entry)
		void entry.conversion.then(
			conversion => {
				if (this.entries.get(partName) !== entry) return

				entry.bytes = conversionBytes(conversion)
				this.bytes += entry.bytes
				this.trim()
			},
			() => {
				if (this.entries.get(partName) === entry) this.entries.delete(partName)
			}
		)
		this.trim()

		return entry.conversion
	}

	clear(): void {
		this.entries.clear()
		this.bytes = 0
	}

	private trim(): void {
		for (const [partName, entry] of this.entries) {
			if (this.entries.size <= MAX_CACHED_METAFILES && this.bytes <= MAX_CACHED_METAFILE_BYTES) return

			this.entries.delete(partName)
			this.bytes -= entry.bytes
		}
	}
}
