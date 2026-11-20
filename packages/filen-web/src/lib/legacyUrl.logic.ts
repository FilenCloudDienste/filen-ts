import { isUuid, UUID_SUB } from "@filen/shared"
import { isContactsSectionFilter } from "@/features/contacts/components/contactsList.logic"
import { syncTab } from "@/features/sync/lib/syncTabs"
import { parsePlanId } from "@/features/settings/lib/billingLinks"
import { resetTokenFromHash } from "@/features/auth/lib/resetToken.logic"

// Every URL an earlier form of this app handed out, rewritten to where it lives now. main.tsx applies the result with
// history.replaceState before the router is created, so the router, its guards and a signed-out visit's return
// target only ever see the new URL. The desktop app runs the same code.
//
// ★ SECURITY: a target is built only from the fixed strings below and ids that passed a shape check (uuid, decimal
// pair id, plan id, an enum), so it is always a same-origin path starting with exactly one "/". Nothing from the
// incoming URL is copied into the path. Secrets (a public link's key, a password-reset token) are written back into
// the FRAGMENT only, which no request carries. Never log the input or the result.
//
// Only two shapes are rewritten, so a rewritten URL is never rewritten again:
//   1. The previous web app (a hash router): pathname "/" and the whole route in the hash ("#/notes/<uuid>"). This app
//      never builds a hash starting with "#/".
//   2. The search-param forms of four pages that moved into the path ("/contacts?section=blocked").
// Anything else, a hostile or malformed URL included, returns null and loads as it is.

export interface LegacyUrlInput {
	pathname: string
	search: string
	hash: string
}

// Far above any real old URL (a public link with a 64-char key is ~110 characters).
const MAX_LEGACY_URL_LENGTH = 2048
// Deeper than any real directory chain.
const MAX_CHAIN_SEGMENTS = 64
const PAIR_ID_RE = /^(?:0|[1-9]\d{0,19})$/
// A public link's key carried back into the fragment: printable ASCII without space, "#", "?" or "\".
const LINK_KEY_RE = /^[\x21\x22\x24-\x3e\x40-\x5b\x5d-\x7e]{1,1024}$/
// The previous app's public links: #/d/<uuid>%23<key> (or a literal "#" before the key), optionally followed by
// ?embed=…&theme=…&hidePreview=… display options, which have no equivalent and are dropped. Its letters are the other
// way round: "d" was a file, "f" a directory.
const LEGACY_PUBLIC_LINK_RE = new RegExp(`^#/([df])/(${UUID_SUB})(?:%23|#)([^?]*)(?:\\?.*)?$`, "i")

const CONTACTS_TABS: Readonly<Record<string, string>> = {
	all: "all",
	online: "contacts",
	offline: "contacts",
	in: "requests",
	out: "pending",
	blocked: "blocked"
}

const SETTINGS_TABS: Readonly<Record<string, string>> = {
	general: "appearance",
	account: "account",
	security: "security",
	subscriptions: "billing",
	invoices: "billing",
	events: "events",
	invite: "billing"
}

const MOUNTS_TABS: Readonly<Record<string, string>> = {
	"network-drive": "drive",
	webdav: "webdav",
	s3: "s3"
}

// Drive views the previous app kept under #/drive/<name>. A chain under the flat ones opens as a plain directory.
const DRIVE_VIEWS: Readonly<Record<string, { root: string; nested: string }>> = {
	recents: { root: "/recents", nested: "/drive" },
	favorites: { root: "/favorites", nested: "/drive" },
	trash: { root: "/trash", nested: "/drive" },
	links: { root: "/links", nested: "/drive" },
	"shared-in": { root: "/shared-in", nested: "/shared-in" },
	"shared-out": { root: "/shared-out", nested: "/shared-out" }
}

function lookup(table: Readonly<Record<string, string>>, key: string | undefined): string | undefined {
	return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
}

// Lower-cased uuids joined with "/", or null when any segment is not a uuid.
function uuidChain(segments: readonly string[]): string | null {
	if (segments.length > MAX_CHAIN_SEGMENTS || !segments.every(isUuid)) {
		return null
	}

	return segments.map(segment => segment.toLowerCase()).join("/")
}

function withChain(base: string, segments: readonly string[]): string | null {
	if (segments.length === 0) {
		return base
	}

	const chain = uuidChain(segments)

	return chain === null ? null : `${base}/${chain}`
}

function plansPath(rawPlan: string | null): string {
	const plan = parsePlanId(rawPlan ?? undefined)

	return plan === undefined ? "/settings/plans" : `/settings/plans/${String(plan)}`
}

function legacyDriveTarget(segments: readonly string[]): string | null {
	const [first, ...rest] = segments

	if (first === undefined) {
		return "/drive"
	}

	const view = Object.hasOwn(DRIVE_VIEWS, first) ? DRIVE_VIEWS[first] : undefined

	if (view !== undefined) {
		return withChain(rest.length === 0 ? view.root : view.nested, rest)
	}

	// The first segment of a My Drive URL was always the root directory's uuid; the new path starts below it.
	return isUuid(first) ? withChain("/drive", rest) : null
}

function legacyRouteTarget(segments: readonly string[], query: URLSearchParams): string | null {
	const [section, second, ...rest] = segments
	const tail = second === undefined ? [] : [second, ...rest]

	switch (section) {
		case "login":
			// The pricing page's sign-in hop carried the plan to pick afterwards; the plans page asks for the sign-in itself.
			return tail.length > 0 ? null : query.has("planId") ? plansPath(query.get("planId")) : "/login"
		case "register":
			return tail.length > 0 ? null : "/register"
		case "drive":
			return legacyDriveTarget(tail)
		case "notes":
		case "chats":
			return tail.length > 1 ? null : withChain(`/${section}`, tail)
		case "contacts": {
			if (tail.length === 0) {
				return "/contacts/all"
			}

			const tab = rest.length === 0 ? lookup(CONTACTS_TABS, second) : undefined

			return tab === undefined ? null : `/contacts/${tab}`
		}
		case "settings": {
			if (tail.length === 0) {
				return "/settings"
			}

			if (rest.length > 0) {
				return null
			}

			if (second === "plans") {
				return plansPath(query.get("id"))
			}

			const tab = lookup(SETTINGS_TABS, second)

			return tab === undefined ? null : `/settings/${tab}`
		}
		case "mounts": {
			if (tail.length === 0) {
				return "/mounts"
			}

			const role = rest.length === 0 ? lookup(MOUNTS_TABS, second) : undefined

			return role === undefined ? null : `/mounts/${role}`
		}
		case "syncs":
			// A pair of the previous desktop app was a uuid; this app numbers its pairs, so the list is the nearest page.
			return tail.length === 0 || (rest.length === 0 && second !== undefined && isUuid(second)) ? "/sync" : null
		case "terminal":
			return tail.length === 0 ? "/" : null
		default:
			return null
	}
}

function hasControlOrSpace(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if (code <= 0x20 || code === 0x7f) {
			return true
		}
	}

	return false
}

function legacyHashTarget(hash: string): string | null {
	const link = LEGACY_PUBLIC_LINK_RE.exec(hash)

	if (link !== null) {
		const [, letter, uuid, key] = link

		if (letter === undefined || uuid === undefined || key === undefined || !LINK_KEY_RE.test(key)) {
			return null
		}

		// The key stays in the fragment, byte for byte; the link page decodes it.
		return `/${letter.toLowerCase() === "d" ? "f" : "d"}/${uuid.toLowerCase()}#${key}`
	}

	const route = hash.slice(2)
	const queryStart = route.indexOf("?")
	const path = queryStart === -1 ? route : route.slice(0, queryStart)
	const query = new URLSearchParams(queryStart === -1 ? "" : route.slice(queryStart + 1))

	// The reset token is the one secret in a route path; like a link key it moves into the fragment, never a path.
	if (path.startsWith("reset/")) {
		const token = path.slice("reset/".length)

		return resetTokenFromHash(token) === null ? null : `/reset#${token}`
	}

	// Only plain ASCII names and uuids make a route: an encoded character, a backslash or a control character means it
	// is not one of the previous app's URLs.
	if (hasControlOrSpace(path) || path.includes("%") || path.includes("\\")) {
		return null
	}

	if (path.length === 0) {
		return "/"
	}

	// One trailing slash was accepted by the previous router; an empty segment anywhere else ("#//host") is not a route.
	const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/")

	return segments.some(segment => segment.length === 0) ? null : legacyRouteTarget(segments, query)
}

// The search-param forms of the pages that moved a param into the path. Only a valid value is rewritten; anything
// else loads as it is and the page applies its own default.
function movedParamTarget(pathname: string, search: string): string | null {
	const query = new URLSearchParams(search)

	if (pathname === "/contacts") {
		const section = query.get("section")

		return section !== null && isContactsSectionFilter(section) ? `/contacts/${section}` : null
	}

	if (pathname === "/playlists") {
		const playlist = query.get("playlist")

		return playlist !== null && isUuid(playlist) ? `/playlists/${playlist.toLowerCase()}` : null
	}

	if (pathname === "/settings/plans") {
		const plan = parsePlanId(query.get("plan") ?? undefined)

		return plan === undefined ? null : `/settings/plans/${String(plan)}`
	}

	const pair = /^\/sync\/([^/]+)$/.exec(pathname)?.[1]
	const tab = query.get("tab")

	if (pair !== undefined && PAIR_ID_RE.test(pair) && tab !== null && syncTab.allows(tab)) {
		return `/sync/${pair}/${tab}`
	}

	return null
}

// Where a URL of an earlier form of this app lives now, as a same-origin path (with a fragment when a secret rides
// along), or null to load the URL unchanged.
export function legacyUrlTarget({ pathname, search, hash }: LegacyUrlInput): string | null {
	if (pathname.length + search.length + hash.length > MAX_LEGACY_URL_LENGTH) {
		return null
	}

	if (pathname === "/" && hash.startsWith("#/")) {
		return legacyHashTarget(hash)
	}

	return search.length > 1 ? movedParamTarget(pathname, search) : null
}
