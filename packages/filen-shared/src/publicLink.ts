import { validateUuid } from "./validate"

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

export const UUID_SUB = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const UUID_RE = new RegExp(`^${UUID_SUB}$`, "i")

// For an id from outside the app (a URL, a pasted link) before it reaches the SDK, which rejects a
// malformed one as a conversion failure rather than answering "not found".
export function isUuid(value: string): boolean {
	return UUID_RE.test(value)
}

const ORIGIN = "^https?://(?:app|drive)\\.filen\\.io/"

// NEW path format (what the current web app builds): <origin>/f|d/<uuid>(#|%23)<hexkey>. Its letters
// read f = file, d = directory, the opposite of the legacy naming below; the scheme stays as shipped.
// The key group is hex-only: the builder always hex-encodes.
const NEW_LINK_RE = new RegExp(`${ORIGIN}([fd])/(${UUID_SUB})(?:#|%23)([0-9a-f]+)`, "i")

// LEGACY hash-router format (old web built these; mobile still does): <origin>/#/d|f/<uuid>(%23|#)<key>,
// where d = download (a file) and f = folder. Both eras stay recognised so old links keep working.
// The key group is broader than NEW's:
// a genuinely raw (non-hex) key of 32+ chars is still a legacy link that must keep being recognized,
// not just a hex-encoded one.
const LEGACY_LINK_RE = new RegExp(`${ORIGIN}#/([df])/(${UUID_SUB})(?:%23|#)([A-Za-z0-9]{32,})`, "i")

const HEX_64_RE = /^[0-9A-Fa-f]{64}$/

// Even-length, all-hex → its UTF-8 plaintext. Anything else (odd length, empty) is null — the caller
// treats that as "not a recognizable link", never a partial parse.
export function decodeHexKey(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0) {
		return null
	}

	try {
		return nodeBuffer().from(hex, "hex").toString("utf8")
	} catch {
		return null
	}
}

export type FilenPublicLink = {
	uuid: string
	// Plaintext key (already hex-decoded), what getLinkedFile/getDirPublicLinkInfo want.
	key: string
	type: "file" | "directory"
}

function finish(uuid: string | undefined, key: string | null, isFile: boolean): FilenPublicLink | null {
	if (uuid === undefined || key === null || nodeBuffer().from(key).length !== 32 || !validateUuid(uuid)) {
		return null
	}

	return {
		uuid,
		key,
		type: isFile ? "file" : "directory"
	}
}

export function parseFilenPublicLink(url: string): FilenPublicLink | null {
	if (!url) {
		return null
	}

	const nw = NEW_LINK_RE.exec(url)

	if (nw !== null) {
		return finish(nw[2], decodeHexKey(nw[3] ?? ""), nw[1]?.toLowerCase() === "f")
	}

	const lg = LEGACY_LINK_RE.exec(url)

	if (lg !== null) {
		const raw = lg[3]
		// A 64-hex key is hex-encoded; anything else is already the raw key.
		const key = raw === undefined ? null : HEX_64_RE.test(raw) ? decodeHexKey(raw) : raw

		// Legacy semantics are swapped: `d` = file, `f` = directory.
		return finish(lg[2], key, lg[1]?.toLowerCase() === "d")
	}

	return null
}
