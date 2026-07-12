import { Buffer } from "buffer"

// Single source of truth for what a Filen public link looks like — both BUILDING one (the drive
// link dialog imports the prefixes + builder here) and PARSING one (the chat-embed recognizer, the
// legacy redirect, and the /f/ /d/ route logic all import from here). Pure: no network, no React,
// no SDK — just string shapes.
//
// ★ SECURITY: the decryption key ALWAYS rides the URL FRAGMENT (after '#'), never the path or a
// query param. A fragment is never sent to any server, so the key stays entirely client-side — the
// same property old-web's hash-router links had implicitly. Nothing in this module may move the key
// out of the fragment, and no caller may log it.
//
// FORMAT ERAS (both recognized; only the NEW one is emitted):
//   NEW (this app, path-based):   https://app.filen.io/f/<uuid>#<hexkey>   → f = FILE, d = DIRECTORY
//   LEGACY (old-web, hash-router): https://app.filen.io/#/f/<uuid>%23<key> → f = DIRECTORY, d = FILE
// The letters are DELIBERATELY swapped between eras. The legacy host set (app|drive).filen.io and
// its %23-or-literal-# separator mirror the shared @filen/utils parser these links round-tripped
// through; this module reimplements the shape web-locally rather than repointing that shared parser
// (mobile still builds legacy-format links and must keep parsing them — it migrates later).

// Canonical host every in-app-built link uses. The key stays in the fragment, so this host only
// pins where the SPA is served, never carries key material.
export const PUBLIC_LINK_ORIGIN = "https://app.filen.io"

// NEW-format prefixes (path-based, swapped from legacy): /f/ = file, /d/ = directory. The builder
// appends `<uuid>#<hexkey>` with a LITERAL '#' so the key lands in a real fragment.
export const FILE_PUBLIC_LINK_URL_PREFIX = `${PUBLIC_LINK_ORIGIN}/f/`
export const DIRECTORY_PUBLIC_LINK_URL_PREFIX = `${PUBLIC_LINK_ORIGIN}/d/`

export type PublicLinkKind = "file" | "directory"

export interface PublicLinkTarget {
	kind: PublicLinkKind
	uuid: string
	// The plaintext key the SDK's getLinkedFile/getDirPublicLinkInfo want — already hex-decoded from
	// what the URL carried, never the hex itself.
	key: string
}

const UUID_SUB = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const UUID_RE = new RegExp(`^${UUID_SUB}$`, "i")

// NEW path format: <origin>/f|d/<uuid>(#|%23)<hexkey>. The key group is hex only (the builder always
// hex-encodes) — a non-hex tail simply fails to match, same negative outcome as a bad link.
const NEW_LINK_RE = new RegExp(`^https?://(?:app|drive)\\.filen\\.io/([fd])/(${UUID_SUB})(?:#|%23)([0-9a-f]+)`, "i")

// LEGACY hash-router format: <origin>/#/f|d/<uuid>(%23|#)<hexkey>, letters swapped vs NEW. Hex-only
// key group mirrors the shape this app itself built under the old convention (the only legacy links
// the chat recognizer ever matched); genuinely raw-key legacy links degrade to a plain link, same as
// today — no regression.
const LEGACY_LINK_RE = new RegExp(`^https?://(?:app|drive)\\.filen\\.io/#/([df])/(${UUID_SUB})(?:%23|#)([0-9a-f]+)`, "i")

// Even-length, all-hex → its UTF-8 plaintext. Anything else (odd length, non-hex, empty) is null —
// the caller treats that as "not a recognizable link", never a partial parse.
function hexDecode(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		return null
	}

	try {
		return Buffer.from(hex, "hex").toString("utf-8")
	} catch {
		return null
	}
}

// Recognizes a full link URL of EITHER era and returns the era-correct kind (letters swapped between
// eras — see the module header). Used by the chat-embed recognizer, so it is strict: the key must be
// valid hex it can decode, otherwise null (render the raw link, never a half-resolved card).
export function parsePublicLink(raw: string): PublicLinkTarget | null {
	const nw = NEW_LINK_RE.exec(raw)

	if (nw !== null) {
		const letter = nw[1]?.toLowerCase()
		const uuid = nw[2]
		const hex = nw[3]

		if (letter === undefined || uuid === undefined || hex === undefined) {
			return null
		}

		const key = hexDecode(hex)

		return key === null ? null : { kind: letter === "f" ? "file" : "directory", uuid, key }
	}

	const lg = LEGACY_LINK_RE.exec(raw)

	if (lg !== null) {
		const letter = lg[1]?.toLowerCase()
		const uuid = lg[2]
		const hex = lg[3]

		if (letter === undefined || uuid === undefined || hex === undefined) {
			return null
		}

		const key = hexDecode(hex)

		// Legacy semantics are swapped: `d` = file, `f` = directory.
		return key === null ? null : { kind: letter === "d" ? "file" : "directory", uuid, key }
	}

	return null
}

// The NEW-format link the drive dialog copies to the clipboard: `<prefix><uuid>#<hexkey>`. `keyPlain`
// is the SDK's plaintext key; it is hex-encoded here purely for URL-safety, decoded back on open. A
// literal '#' (not encodeURIComponent) so the key is a genuine fragment, never sent to the server.
export function buildPublicLinkUrl(kind: PublicLinkKind, uuid: string, keyPlain: string): string {
	const prefix = kind === "file" ? FILE_PUBLIC_LINK_URL_PREFIX : DIRECTORY_PUBLIC_LINK_URL_PREFIX

	return `${prefix}${uuid}#${Buffer.from(keyPlain, "utf-8").toString("hex")}`
}

// A too-short fragment is rejected outright ("key invalid or expired" — a real key is 64 hex chars,
// or a 32-char legacy raw key). Comfortably below both, well above any accidental short garbage.
const MIN_KEY_FRAGMENT_LENGTH = 16

function stripLeadingHash(fragment: string): string {
	return fragment.startsWith("#") ? fragment.slice(1) : fragment
}

// Decodes the key carried in a route's URL fragment to the SDK's plaintext key. Lenient (unlike the
// chat recognizer): an even-length all-hex fragment is this app's own hex-encoded key and is decoded;
// anything else is taken verbatim as an already-plaintext key (a legacy link redirected in with a raw
// key). Returns null for an empty / too-short fragment — the route's "key too short" invalid trigger.
function decodeLinkKeyFragment(fragment: string): string | null {
	const trimmed = stripLeadingHash(fragment)

	if (trimmed.length < MIN_KEY_FRAGMENT_LENGTH) {
		return null
	}

	const key = /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 ? hexDecode(trimmed) : trimmed

	return key === null || key.length === 0 ? null : key
}

export interface ResolvedRouteLink {
	uuid: string
	key: string
}

// Route-side resolution: the KIND is fixed by which route rendered (/f/ = file, /d/ = dir), so only
// the uuid + key are resolved here. The uuid comes from the path param; the key from the URL fragment
// (window.location.hash) so it stays client-side. Defensive fallback for a hand-built link that put
// the key in the PATH via %23 instead of a real fragment: split the param on the first %23/# and take
// the tail as the key. Returns null (→ the shared invalid surface) for a bad uuid or a bad/short key.
export function resolveRouteLink(uuidParam: string, hash: string): ResolvedRouteLink | null {
	let uuid = uuidParam
	let rawKey = stripLeadingHash(hash)

	if (rawKey.length === 0) {
		const m = /^(.*?)(?:%23|#)(.+)$/.exec(uuidParam)
		const splitUuid = m?.[1]
		const splitKey = m?.[2]

		if (splitUuid !== undefined && splitKey !== undefined) {
			uuid = splitUuid
			rawKey = splitKey
		}
	}

	uuid = uuid.toLowerCase()

	if (!UUID_RE.test(uuid)) {
		return null
	}

	const key = decodeLinkKeyFragment(rawKey)

	return key === null ? null : { uuid, key }
}

export interface LegacyRedirectTarget {
	// The RESOLVED content kind (already un-swapped) — the redirect site maps it back to the new route
	// letter (file → /f/, directory → /d/).
	kind: PublicLinkKind
	uuid: string
	// The key exactly as the legacy fragment carried it — preserved verbatim into the new fragment so
	// no re-encoding can corrupt a raw-vs-hex legacy key. The new route's resolver decodes it.
	key: string
}

// The whole legacy route lives in window.location.hash (old-web was a hash router, so the server
// never saw it — this is client-side by construction). Given that hash, if it is a legacy public-link
// shape, derive the NEW swapped-path target (legacy /f/ = dir → new /d/; legacy /d/ = file → new /f/),
// key preserved verbatim. A non-link hash returns null → the index route keeps its normal behavior.
const LEGACY_HASH_RE = new RegExp(`^#/([df])/(${UUID_SUB})(?:%23|#)(.+)$`, "i")

export function deriveLegacyRedirect(hash: string): LegacyRedirectTarget | null {
	const m = LEGACY_HASH_RE.exec(hash)

	if (m === null) {
		return null
	}

	const letter = m[1]?.toLowerCase()
	const uuid = m[2]
	const key = m[3]

	if (letter === undefined || uuid === undefined || key === undefined || key.length === 0) {
		return null
	}

	// Legacy letters are swapped: `d` = file, `f` = directory.
	return { kind: letter === "d" ? "file" : "directory", uuid, key }
}
