/**
 * Pure helpers for handling external link URLs in the note editors.
 *
 * Shared by the markdown DOM preview (dom.tsx) and the rich-text toolbar so both
 * editors normalise and classify links identically — and so the logic is
 * unit-testable in isolation (no native / DOM imports here).
 */

export const EXTERNAL_LINK_PROTOCOLS = ["http://", "https://", "mailto:", "tel:", "sms:", "whatsapp:", "geo:", "maps:"] as const

/**
 * Normalise a user-entered or document href.
 *
 * `url` is only trimmed — never lowercased — because paths, query strings and
 * tokens can be case-sensitive (password-reset links, signed URLs, etc.). Only
 * the protocol allowlist check is case-insensitive.
 */
export function classifyExternalLinkHref(raw: string): {
	url: string
	intercept: boolean
} {
	const url = raw.trim()
	const lower = url.toLowerCase()
	const intercept = EXTERNAL_LINK_PROTOCOLS.some(protocol => lower.startsWith(protocol))

	return {
		url,
		intercept
	}
}
