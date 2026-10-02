import { Buffer } from "buffer"
import { UUID_SUB, decodeHexKey } from "@filen/shared"

// Single source of truth for what a Filen public link looks like — both BUILDING one (the drive
// link dialog imports the prefixes + builder here) and resolving one (the legacy redirect and the
// /f/ /d/ route logic import from here). Pure: no network, no React, no SDK — just string shapes.
//
// ★ SECURITY: the decryption key ALWAYS rides the URL FRAGMENT (after '#'), never the path or a
// query param. A fragment is never sent to any server, so the key stays entirely client-side — the
// same property old-web's hash-router links had implicitly. Nothing in this module may move the key
// out of the fragment, and no caller may log it.
//
// FORMAT ERAS (both recognized; only the NEW one is emitted):
//   NEW (this app, path-based):   <origin>/f/<uuid>#<hexkey>              → f = file, d = directory (this app's own scheme)
//   LEGACY (old-web, hash-router): https://app.filen.io/#/f/<uuid>%23<key> → f = folder, d = download (a file): the legacy naming
// The letters are DELIBERATELY swapped between eras. PARSING both eras is owned by @filen/shared's
// parseFilenPublicLink; only the BUILD side (prefixes below) stays app-local, since mobile still
// builds legacy-format links and web builds NEW-format ones.

// NEW-format paths (the letters deliberately differ from the legacy naming, where f meant folder and d
// meant download): /f/ = file, /d/ = directory. The builder appends `<uuid>#<hexkey>` with a LITERAL '#'
// so the key lands in a real fragment.
const FILE_PUBLIC_LINK_PATH = "/f/"
const DIRECTORY_PUBLIC_LINK_PATH = "/d/"

export type PublicLinkKind = "file" | "directory"

const UUID_RE = new RegExp(`^${UUID_SUB}$`, "i")

// The NEW-format link the drive dialog copies to the clipboard: `<origin>/<f|d>/<uuid>#<hexkey>`. The
// origin is the one this app is served from (production, staging or a dev server): a link opens in this
// same app, and the key in the fragment never reaches any server, whichever it is. `keyPlain` is the
// SDK's plaintext key; it is hex-encoded here purely for URL-safety, decoded back on open. A literal '#'
// (not encodeURIComponent) so the key is a genuine fragment.
export function buildPublicLinkUrl(kind: PublicLinkKind, uuid: string, keyPlain: string, origin: string = location.origin): string {
	const path = kind === "file" ? FILE_PUBLIC_LINK_PATH : DIRECTORY_PUBLIC_LINK_PATH

	return `${origin}${path}${uuid}#${Buffer.from(keyPlain, "utf-8").toString("hex")}`
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

	const key = /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 ? decodeHexKey(trimmed) : trimmed

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
