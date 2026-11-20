import { describe, expect, it } from "vitest"
import { legacyUrlTarget } from "@/lib/legacyUrl.logic"

// Every URL an earlier form of the app handed out, against where it opens now (docs/web-routes-audit.md, Part C).
// `fragment` is what stays after "#" in the new URL: only ever a public link's key or a reset token.

const UUID = "11111111-2222-4333-8444-555555555555"
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const UUID_C = "cccccccc-dddd-4eee-8fff-000000000000"
const KEY_HEX = "3031323334353637383961626364656630313233343536373839616263646566"
const KEY_RAW = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const TOKEN = "f3a9c1d2e4b5a6c7d8e9f0a1b2c3d4e5"

function hashTarget(hash: string): string | null {
	return legacyUrlTarget({ pathname: "/", search: "", hash })
}

function fragmentOf(target: string | null): string | null {
	if (target === null) {
		return null
	}

	const at = target.indexOf("#")

	return at === -1 ? null : target.slice(at + 1)
}

interface Row {
	audit: string
	old: string
	target: string
	fragment?: string
}

// The previous web app's hash routes.
const HASH_ROWS: readonly Row[] = [
	{ audit: "A1", old: "#/", target: "/" },
	{ audit: "A2", old: "#/login", target: "/login" },
	{ audit: "A3", old: "#/login?planId=30", target: "/settings/plans/30" },
	{ audit: "A3", old: "#/login?planId=abc", target: "/settings/plans" },
	{ audit: "A4", old: "#/register", target: "/register" },
	{ audit: "A4", old: "#/register?ref=abc", target: "/register" },
	{ audit: "A5", old: `#/reset/${TOKEN}`, target: `/reset#${TOKEN}`, fragment: TOKEN },
	{ audit: "A6", old: `#/d/${UUID}%23${KEY_HEX}`, target: `/f/${UUID}#${KEY_HEX}`, fragment: KEY_HEX },
	{ audit: "A6", old: `#/d/${UUID}#${KEY_RAW}`, target: `/f/${UUID}#${KEY_RAW}`, fragment: KEY_RAW },
	{
		audit: "A7",
		old: `#/d/${UUID}%23${KEY_HEX}?embed=true&theme=dark&color=ff0000&hidePreview=true&chatEmbed=true`,
		target: `/f/${UUID}#${KEY_HEX}`,
		fragment: KEY_HEX
	},
	{ audit: "A8", old: `#/f/${UUID}%23${KEY_HEX}`, target: `/d/${UUID}#${KEY_HEX}`, fragment: KEY_HEX },
	{ audit: "A8", old: `#/F/${UUID.toUpperCase()}%23${KEY_RAW}`, target: `/d/${UUID}#${KEY_RAW}`, fragment: KEY_RAW },
	{ audit: "A9", old: `#/f/${UUID}#${KEY_HEX}?embed=true&theme=light`, target: `/d/${UUID}#${KEY_HEX}`, fragment: KEY_HEX },
	{ audit: "A10", old: "#/drive", target: "/drive" },
	{ audit: "A10", old: `#/drive/${UUID}`, target: "/drive" },
	{ audit: "A10", old: `#/drive/${UUID}/${UUID_B}/${UUID_C}`, target: `/drive/${UUID_B}/${UUID_C}` },
	{ audit: "A10", old: `#/drive/${UUID}/${UUID_B.toUpperCase()}`, target: `/drive/${UUID_B}` },
	{ audit: "A11", old: "#/drive/recents", target: "/recents" },
	{ audit: "A12", old: "#/drive/favorites", target: "/favorites" },
	{ audit: "A12", old: `#/drive/favorites/${UUID_B}/${UUID_C}`, target: `/drive/${UUID_B}/${UUID_C}` },
	{ audit: "A13", old: "#/drive/trash", target: "/trash" },
	{ audit: "A14", old: "#/drive/shared-in", target: "/shared-in" },
	{ audit: "A14", old: `#/drive/shared-in/${UUID_B}`, target: `/shared-in/${UUID_B}` },
	{ audit: "A15", old: "#/drive/shared-out", target: "/shared-out" },
	{ audit: "A15", old: `#/drive/shared-out/${UUID_B}/${UUID_C}`, target: `/shared-out/${UUID_B}/${UUID_C}` },
	{ audit: "A16", old: "#/drive/links", target: "/links" },
	{ audit: "A16", old: `#/drive/links/${UUID_B}`, target: `/drive/${UUID_B}` },
	{ audit: "A17", old: "#/notes", target: "/notes" },
	{ audit: "A18", old: `#/notes/${UUID}`, target: `/notes/${UUID}` },
	{ audit: "A19", old: "#/chats", target: "/chats" },
	{ audit: "A20", old: `#/chats/${UUID}`, target: `/chats/${UUID}` },
	{ audit: "A21", old: "#/contacts/online", target: "/contacts/contacts" },
	{ audit: "A22", old: "#/contacts/all", target: "/contacts/all" },
	{ audit: "A23", old: "#/contacts/offline", target: "/contacts/contacts" },
	{ audit: "A24", old: "#/contacts/in", target: "/contacts/requests" },
	{ audit: "A25", old: "#/contacts/out", target: "/contacts/pending" },
	{ audit: "A26", old: "#/contacts/blocked", target: "/contacts/blocked" },
	{ audit: "A21-A26", old: "#/contacts", target: "/contacts/all" },
	{ audit: "A27", old: "#/settings/general", target: "/settings/appearance" },
	{ audit: "A28", old: "#/settings/account", target: "/settings/account" },
	{ audit: "A29", old: "#/settings/security", target: "/settings/security" },
	{ audit: "A30", old: "#/settings/subscriptions", target: "/settings/billing" },
	{ audit: "A31", old: "#/settings/invoices", target: "/settings/billing" },
	{ audit: "A32", old: "#/settings/plans", target: "/settings/plans" },
	{ audit: "A33", old: "#/settings/plans?id=27", target: "/settings/plans/27" },
	{ audit: "A33", old: "#/settings/plans?id=-3", target: "/settings/plans" },
	{ audit: "A33", old: "#/settings/plans?id=99999999999999999999", target: "/settings/plans" },
	{ audit: "A34", old: "#/settings/events", target: "/settings/events" },
	{ audit: "A35", old: "#/settings/invite", target: "/settings/billing" },
	{ audit: "A27-A35", old: "#/settings", target: "/settings" },
	{ audit: "A36", old: "#/mounts/network-drive", target: "/mounts/drive" },
	{ audit: "A37", old: "#/mounts/webdav", target: "/mounts/webdav" },
	{ audit: "A38", old: "#/mounts/s3", target: "/mounts/s3" },
	{ audit: "A36-A38", old: "#/mounts", target: "/mounts" },
	{ audit: "A39", old: "#/syncs", target: "/sync" },
	{ audit: "A40", old: `#/syncs/${UUID}`, target: "/sync" },
	{ audit: "A41", old: "#/terminal", target: "/" },
	{ audit: "trailing slash", old: "#/notes/", target: "/notes" }
]

// The search-param forms of the four pages whose param moved into the path.
const MOVED_PARAM_ROWS: readonly (Row & { pathname: string })[] = [
	{ audit: "D contacts", old: "?section=blocked", pathname: "/contacts", target: "/contacts/blocked" },
	{ audit: "D contacts", old: "?section=all", pathname: "/contacts", target: "/contacts/all" },
	{ audit: "D playlists", old: `?playlist=${UUID}`, pathname: "/playlists", target: `/playlists/${UUID}` },
	{ audit: "D playlists", old: `?playlist=${UUID.toUpperCase()}`, pathname: "/playlists", target: `/playlists/${UUID}` },
	{ audit: "D sync", old: "?tab=issues", pathname: "/sync/12", target: "/sync/12/issues" },
	{ audit: "D sync", old: "?tab=settings", pathname: "/sync/0", target: "/sync/0/settings" },
	{ audit: "D plans", old: "?plan=27", pathname: "/settings/plans", target: "/settings/plans/27" }
]

describe("legacyUrlTarget: the previous web app's hash routes", () => {
	it.each(HASH_ROWS)("$audit $old → $target", ({ old, target, fragment }) => {
		const result = hashTarget(old)

		expect(result).toBe(target)
		// Only a link key or a reset token stays in the fragment, unchanged; nothing else gets one.
		expect(fragmentOf(result)).toBe(fragment ?? null)
		// A same-origin path: exactly one leading slash.
		expect(result?.startsWith("/")).toBe(true)
		expect(result?.startsWith("//")).toBe(false)
	})

	it.each(HASH_ROWS)("$audit: rewriting the result again changes nothing", ({ old }) => {
		const once = hashTarget(old)

		expect(once).not.toBeNull()

		const url = new URL(once ?? "", "https://app.invalid")

		expect(legacyUrlTarget({ pathname: url.pathname, search: url.search, hash: url.hash })).toBeNull()
	})

	it("never takes a secret out of the fragment", () => {
		for (const { old, fragment } of HASH_ROWS) {
			const result = hashTarget(old) ?? ""
			const at = result.indexOf("#")
			const pathPart = at === -1 ? result : result.slice(0, at)

			if (fragment !== undefined) {
				expect(pathPart).not.toContain(fragment)
				expect(pathPart).not.toContain("?")
			}
		}
	})
})

describe("legacyUrlTarget: the four page params that moved into the path", () => {
	it.each(MOVED_PARAM_ROWS)("$pathname$old → $target", ({ pathname, old, target }) => {
		const result = legacyUrlTarget({ pathname, search: old, hash: "" })

		expect(result).toBe(target)

		const url = new URL(result ?? "", "https://app.invalid")

		// Idempotent: the new path form is left alone.
		expect(legacyUrlTarget({ pathname: url.pathname, search: url.search, hash: url.hash })).toBeNull()
	})

	it.each([
		["/contacts", "?section=online"],
		["/contacts", "?section="],
		["/playlists", "?playlist=not-a-uuid"],
		["/playlists", "?playlist=..%2F..%2Fsettings"],
		["/sync/12", "?tab=bogus"],
		["/sync/abc", "?tab=issues"],
		["/sync/012", "?tab=issues"],
		["/settings/plans", "?plan=0"],
		["/settings/plans", "?plan=1e3"],
		["/settings/plans", "?plan=//evil.com"],
		["/settings/account", "?plan=27"],
		["/drive", "?section=blocked"]
	])("leaves %s%s for the page's own default", (pathname, search) => {
		expect(legacyUrlTarget({ pathname, search, hash: "" })).toBeNull()
	})

	it("ignores a bare page without the old param", () => {
		expect(legacyUrlTarget({ pathname: "/contacts", search: "", hash: "" })).toBeNull()
		expect(legacyUrlTarget({ pathname: "/playlists", search: "?", hash: "" })).toBeNull()
	})
})

describe("legacyUrlTarget: hostile and unknown input loads unchanged", () => {
	it.each([
		// Off-origin and scheme-changing shapes.
		"#//evil.com",
		"#//evil.com/notes",
		"#/\\evil.com",
		"#/\\\\evil.com",
		"#/https://evil.com",
		"#/http:/evil.com",
		"#/javascript:alert(1)",
		"#/notes/javascript:alert(1)",
		"#/%2F%2Fevil.com",
		"#/%5Cevil.com",
		// Encoded slashes and traversal.
		`#/drive/${UUID}%2F..%2F..%2Fsettings`,
		"#/drive/../settings",
		`#/drive/${UUID}/../../settings`,
		"#/notes/..",
		"#/notes/%2e%2e",
		`#/notes/${UUID}/extra`,
		"#/contacts/online/extra",
		"#/settings/account/extra",
		// Whitespace and control characters.
		"#/notes/\tx",
		"#/\nnotes",
		"#/ notes",
		// Not a route of the previous app.
		"#/unknown",
		"#/drive/not-a-uuid",
		`#/drive/${UUID}/not-a-uuid`,
		"#/notes/not-a-uuid",
		"#/contacts/friends",
		"#/settings/nope",
		"#/mounts/ftp",
		"#/syncs/12",
		"#/terminal/x",
		"#/login/x",
		// Public links without a usable key.
		`#/d/${UUID}`,
		`#/d/${UUID}%23`,
		`#/d/${UUID}%23?embed=true`,
		`#/d/${UUID}%23key with space`,
		"#/d/not-a-uuid%23abcdef0123456789",
		// Reset links without a usable token.
		"#/reset/",
		"#/reset/a/b",
		"#/reset/a b",
		`#/reset/${"x".repeat(1025)}`
	])("%s", hash => {
		expect(hashTarget(hash)).toBeNull()
	})

	it("ignores a hash that is not a route (this app's own fragments, an anchor)", () => {
		expect(hashTarget("")).toBeNull()
		expect(hashTarget("#")).toBeNull()
		expect(hashTarget(`#${KEY_HEX}`)).toBeNull()
		expect(hashTarget("#section-heading")).toBeNull()
	})

	it("only rewrites a hash route on the root path", () => {
		expect(legacyUrlTarget({ pathname: "/notes", search: "", hash: "#/notes" })).toBeNull()
		expect(legacyUrlTarget({ pathname: `/f/${UUID}`, search: "", hash: `#/d/${UUID}%23${KEY_HEX}` })).toBeNull()
	})

	it("refuses oversized input", () => {
		const chain = Array.from({ length: 65 }, () => UUID_B).join("/")

		expect(hashTarget(`#/drive/${UUID}/${chain}`)).toBeNull()
		expect(hashTarget(`#/notes?${"a".repeat(5000)}`)).toBeNull()
		expect(legacyUrlTarget({ pathname: "/contacts", search: `?section=all&x=${"a".repeat(5000)}`, hash: "" })).toBeNull()
	})

	it("keeps a reset token with the characters a token may carry, in the fragment only", () => {
		const token = "Ab-_.~%2B9"

		expect(hashTarget(`#/reset/${token}`)).toBe(`/reset#${token}`)
		expect(hashTarget(`#/reset/${token}?utm=x`)).toBe(`/reset#${token}`)
	})
})
