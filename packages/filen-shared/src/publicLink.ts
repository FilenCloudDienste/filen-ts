import { validate as validateUUID } from "uuid"

/**
 * Buffer typed here and read at CALL time: this file is consumed as source by clients whose tsconfig
 * carries no Node globals, and React Native installs its polyfill at app start, so capturing the
 * global at module evaluation would bind undefined. An ambient `declare const Buffer` would instead
 * collide with @types/node wherever a consumer does have it.
 */
type BufferLike = {
	from(input: string, encoding?: string): { toString(encoding?: string): string; length: number }
}

function nodeBuffer(): BufferLike {
	return (globalThis as unknown as { Buffer: BufferLike }).Buffer
}

const UUID_SUB = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

// NEW path format (what this app's own share dialog builds): <origin>/f|d/<uuid>(#|%23)<hexkey>,
// f = FILE, d = DIRECTORY. The key group is hex-only — the builder always hex-encodes.
const NEW_LINK_RE = new RegExp(`^https?://(?:app|drive)\\.filen\\.io/([fd])/(${UUID_SUB})(?:#|%23)([0-9a-f]+)`, "i")

// LEGACY hash-router format (old-web built these; mobile still does): <origin>/#/d|f/<uuid>(%23|#)<key>,
// letters DELIBERATELY swapped vs NEW (d = FILE, f = DIRECTORY). The key group is broader than NEW's:
// a genuinely raw (non-hex) key of 32+ chars is still a legacy link that must keep being recognized,
// not just a hex-encoded one.
const LEGACY_LINK_RE = new RegExp(`^https?://(?:app|drive)\\.filen\\.io/#/([df])/(${UUID_SUB})(?:%23|#)([A-Za-z0-9]{32,})`, "i")

const HEX_64_RE = /^[0-9A-Fa-f]{64}$/

// Even-length, all-hex → its UTF-8 plaintext. Anything else (odd length, empty) is null — the caller
// treats that as "not a recognizable link", never a partial parse.
function decodeHexKey(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0) {
		return null
	}

	try {
		return nodeBuffer().from(hex, "hex").toString("utf8")
	} catch {
		return null
	}
}

export function parseFilenPublicLink(url: string): { uuid: string; key: string; type: "file" | "directory" } | null {
	if (!url || url.length === 0) {
		return null
	}

	const nw = NEW_LINK_RE.exec(url)

	if (nw !== null) {
		const pathType = nw[1]?.toLowerCase()
		const uuid = nw[2]
		const hex = nw[3]

		if (pathType === undefined || uuid === undefined || hex === undefined) {
			return null
		}

		const key = decodeHexKey(hex)

		if (key === null || nodeBuffer().from(key).length !== 32 || !validateUUID(uuid)) {
			return null
		}

		return {
			uuid,
			key,
			type: pathType === "f" ? "file" : "directory"
		}
	}

	const lg = LEGACY_LINK_RE.exec(url)

	if (lg !== null) {
		const pathType = lg[1]?.toLowerCase()
		const uuid = lg[2]
		let key = lg[3]

		if (pathType === undefined || uuid === undefined || key === undefined) {
			return null
		}

		if (HEX_64_RE.test(key)) {
			const decoded = decodeHexKey(key)

			if (decoded === null) {
				return null
			}

			key = decoded
		}

		if (nodeBuffer().from(key).length !== 32 || !validateUUID(uuid)) {
			return null
		}

		// Legacy semantics are swapped: `d` = file, `f` = directory.
		return {
			uuid,
			key,
			type: pathType === "d" ? "file" : "directory"
		}
	}

	return null
}
