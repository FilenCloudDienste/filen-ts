// Pure hyperlink-scheme validation for docx-viewer.tsx — framework-free so it is testable in node
// (docx-viewer.logic.test.ts) with no DOM involved.

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

// docx-preview's renderHyperlink copies a relationship's target straight into `href` with no scheme
// check — a crafted docx can carry a javascript: (or data:, vbscript:, file:, ...) target. The URL
// constructor is used instead of a regex specifically because it normalizes what it parses (lowercases
// the scheme, strips leading/embedded whitespace inside it) before `.protocol` is read, so an
// obfuscated scheme like " javascript:..." or "java\tscript:..." can't slip past a naive string match.
// The placeholder base only lets a relative-looking href (e.g. an empty relationship target, or an
// anchor-only "#section") resolve instead of throwing — it never affects the safety verdict, since a
// relative reference always inherits the base's own (https:) scheme.
export function isSafeLinkHref(href: string): boolean {
	try {
		const url = new URL(href, "https://docx-preview.invalid/")

		return SAFE_LINK_PROTOCOLS.has(url.protocol)
	} catch {
		return false
	}
}
