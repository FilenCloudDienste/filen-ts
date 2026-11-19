// The one classifier for links taken from content the user did not author (documents, notes, messages),
// on every platform. An allowlist, never a denylist: a `javascript:` denylist is bypassable because URL
// parsers strip embedded tabs, newlines and leading control characters (`java\tscript:x`, `\x01javascript:x`
// both navigate), while an allowlist fails those closed.
//
// String-only on purpose (no URL constructor): it runs unchanged on Hermes and in the browser. The scheme
// test is a prefix test on the trimmed value, so http(s) must be written with "//": "https:/x" and
// "http:host" resolve against a page of the same scheme in a browser and are refused here.

export type LinkScheme = "http:" | "https:" | "mailto:" | "tel:" | "sms:" | "whatsapp:" | "geo:" | "maps:"

// Each allowed scheme with the prefix a link must start with (case-insensitively).
export const LINK_SCHEMES: readonly (readonly [prefix: string, scheme: LinkScheme])[] = [
	["http://", "http:"],
	["https://", "https:"],
	["mailto:", "mailto:"],
	["tel:", "tel:"],
	["sms:", "sms:"],
	["whatsapp:", "whatsapp:"],
	["geo:", "geo:"],
	["maps:", "maps:"]
]

// internal: a pure `#fragment`, resolved inside the document (the fragment excludes the "#").
// external: an allowlisted scheme; `url` is the trimmed value with its original casing (paths, queries and
// tokens are case-sensitive), `scheme` lowercased.
// blocked: everything else, rendered as inert text.
export type LinkVerdict =
	{ kind: "internal"; fragment: string } | { kind: "external"; url: string; scheme: LinkScheme } | { kind: "blocked" }

const BLOCKED: LinkVerdict = { kind: "blocked" }

// Any whitespace or control character (C0, DEL, C1: everything outside printable ASCII and U+00A0 onwards). A
// legitimate href carries none once it is a URL (a space is %20), and without this check a value that merely
// starts with an allowed scheme would carry whatever follows it (`tel:+1\njavascript:...`).
const WHITESPACE_OR_CONTROL = /\s|[^\x20-\x7e\xa0-\uffff]/

// An http(s) URL needs a host after the "//": the authority (up to "/", "?", "#" or the end) is an optional
// userinfo ending in its last "@", then a bracketed IPv6 address or a hostname, then an optional port.
const HAS_HOST = /^(?:[^/?#]*@)?(?:\[[^\]]+\]|[^:/?#@[\]])[^/?#@]*(?:[/?#]|$)/

export function classifyLink(raw: string | null | undefined): LinkVerdict {
	if (typeof raw !== "string") {
		return BLOCKED
	}

	const url = raw.trim()

	if (url.length === 0 || WHITESPACE_OR_CONTROL.test(url)) {
		return BLOCKED
	}

	// Before the scheme test: a fragment carries no scheme, and `#javascript:x` is a fragment identifier only.
	if (url.startsWith("#")) {
		return { kind: "internal", fragment: url.slice(1) }
	}

	const lower = url.toLowerCase()
	const match = LINK_SCHEMES.find(([prefix]) => lower.startsWith(prefix))

	if (match === undefined) {
		return BLOCKED
	}

	const [prefix, scheme] = match

	if (isWebLinkScheme(scheme) && !HAS_HOST.test(url.slice(prefix.length))) {
		return BLOCKED
	}

	return { kind: "external", url, scheme }
}

// http(s): the only schemes with a host to vet and confirm. The others hand off to the OS's own compose,
// dial or map UI, which is the confirmation for them.
export function isWebLinkScheme(scheme: LinkScheme): boolean {
	return scheme === "http:" || scheme === "https:"
}
