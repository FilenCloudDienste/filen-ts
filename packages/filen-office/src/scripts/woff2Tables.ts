import { brotliDecompressSync } from "node:zlib"
import { readWoff2Directory, woff2Tables } from "../core/fonts/woff"

// Pulls the untransformed tables out of a WOFF2 file (core/fonts/woff.ts) and wraps them in a minimal sfnt, which is
// all the metrics reader needs. glyf/loca (transformed by WOFF2) are left out: rebuilding outlines is the browser's
// job.

export const METRIC_TABLES = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2"]

export function sfntFromWoff2(woff2: Uint8Array, tags: readonly string[] = METRIC_TABLES): Uint8Array {
	const directory = readWoff2Directory(woff2)
	const wanted = new Set(tags)

	for (const entry of directory.entries) {
		if (wanted.has(entry.tag) && entry.transformed) throw new Error(`Table ${entry.tag} is transformed`)
	}

	const compressed = woff2.subarray(directory.streamOffset, directory.streamOffset + directory.compressedLength)
	const stream = new Uint8Array(brotliDecompressSync(compressed))

	return buildSfnt(directory.flavor, woff2Tables(directory, stream, wanted))
}

export function buildSfnt(flavor: number, tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
	const tags = [...tables.keys()].sort()
	let size = 12 + tags.length * 16

	for (const tag of tags) size += ((tables.get(tag)?.length ?? 0) + 3) & ~3

	const out = new Uint8Array(size)
	const view = new DataView(out.buffer)
	const power = 2 ** Math.floor(Math.log2(Math.max(1, tags.length)))

	view.setUint32(0, flavor)
	view.setUint16(4, tags.length)
	view.setUint16(6, power * 16)
	view.setUint16(8, Math.log2(power))
	view.setUint16(10, tags.length * 16 - power * 16)

	let offset = 12 + tags.length * 16

	tags.forEach((tag, i) => {
		const table = tables.get(tag) ?? new Uint8Array(0)
		const record = 12 + i * 16

		for (let k = 0; k < 4; k++) view.setUint8(record + k, tag.charCodeAt(k))

		view.setUint32(record + 8, offset)
		view.setUint32(record + 12, table.length)
		out.set(table, offset)
		offset += (table.length + 3) & ~3
	})

	return out
}
