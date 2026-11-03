import { Gunzip } from "fflate"
import { Bytes } from "./bytes"
import { convertEmf, isEmf } from "./emf"
import { MAX_METAFILE_BYTES, MAX_NESTING } from "./limits"
import type { MetafileConversion } from "./types"
import { convertWmf, isWmf } from "./wmf"

// EMF, EMF+ and WMF pictures as drawing lists (SVM and PICT, which only presentations hold, convert through legacy.ts). Pure data in, numbers, enums and run text out: no network,
// no evaluation, every count bounded (limits.ts). Embedded bitmaps become image entries that carry their
// encoded bytes for the renderer to show as object URLs.

export { DR3D_LIMITS, drawScene, readScene, transform3d, type Dr3dScene, type SceneSource } from "./dr3d"
export { expandMetafiles, hasMetafileImages } from "./embed"
export { MAX_METAFILE_BYTES } from "./limits"
export type { MetafileConversion, MetafileFailure, MetafileFormat } from "./types"

class TooLarge extends Error {}

// Compressed bytes per inflate step: fflate inflates all it is given before handing anything over, so the
// cap is checked after at most ~1032 times this much output.
const INFLATE_STEP = 8 * 1024

// A gzip-compressed metafile (.emz, .wmz) inflated, or undefined when it is not gzip, is corrupt, or
// inflates beyond the input bound.
export function inflateMetafile(bytes: Uint8Array): Uint8Array | undefined {
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return undefined

	const chunks: Uint8Array[] = []
	let total = 0
	const gunzip = new Gunzip(chunk => {
		total += chunk.length

		if (total > MAX_METAFILE_BYTES) throw new TooLarge()

		chunks.push(chunk)
	})

	try {
		for (let at = 0; at < bytes.length; at += INFLATE_STEP) {
			gunzip.push(bytes.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= bytes.length)
		}
	} catch {
		return undefined
	}

	const out = new Uint8Array(total)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

export function metafileFormat(bytes: Uint8Array): "emf" | "wmf" | undefined {
	const view = new Bytes(bytes)

	return isEmf(view) ? "emf" : isWmf(view) ? "wmf" : undefined
}

function convert(bytes: Uint8Array, depth: number): MetafileConversion {
	if (depth > MAX_NESTING) return { ok: false, reason: "nested" }

	let input = bytes

	if (input[0] === 0x1f && input[1] === 0x8b) {
		const inflated = inflateMetafile(input)

		if (inflated === undefined) return { ok: false, reason: "malformed" }

		input = inflated
	}

	if (input.length > MAX_METAFILE_BYTES) return { ok: false, reason: "tooLarge" }

	const view = new Bytes(input)

	try {
		if (isEmf(view)) return convertEmf(view, nested => convert(nested, depth + 1))
		if (isWmf(view)) return convertWmf(view, nested => convert(nested, depth + 1))
	} catch {
		return { ok: false, reason: "failed" }
	}

	return { ok: false, reason: "malformed" }
}

// Converts an EMF (with its EMF+ records), WMF, or a gzip-compressed one of them. Never throws.
export function convertMetafile(bytes: Uint8Array): MetafileConversion {
	return convert(bytes, 0)
}
