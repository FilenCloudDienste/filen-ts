// The single URL-safety verdict for hrefs taken from untrusted content (documents, manifests, chat
// text). The URL constructor rather than a regex, because it normalizes what it parses (lowercases the
// scheme, strips leading/embedded whitespace inside it) before `.protocol` is read, so an obfuscated
// scheme like " javascript:..." or "java\tscript:..." can't slip past a naive string match. Parsed
// with no base: a relative or fragment-only reference would resolve against the app's own origin and
// open a copy of the app, so it is rejected along with every unlisted scheme.

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export function isSafeAbsoluteHref(href: string): boolean {
	try {
		return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol)
	} catch {
		return false
	}
}

// The stricter http(s)-only parse, for links that must open a web page (no mailto:).
export function webUrl(raw: string): URL | null {
	try {
		const url = new URL(raw)

		return url.protocol === "http:" || url.protocol === "https:" ? url : null
	} catch {
		return null
	}
}
