/**
 * One classifier for every link that came out of content the user did not author — a previewed
 * document, a rendered PDF, a shared note.
 *
 * Extracted from the .docx preview so the PDF viewer does not grow a second, subtly different copy.
 * Two classifiers drifting apart is how one surface ends up permitting what the other blocks, and the
 * reasoning below was arrived at once and should not have to be rediscovered per format.
 *
 * ALLOWLIST, never a denylist. A `javascript:`-matching denylist is bypassable — browsers strip
 * embedded tabs/newlines and leading control characters while parsing a URL, so `java\tscript:x` and
 * `\x01javascript:x` both navigate but neither matches a naive prefix test. An allowlist fails those
 * closed: anything not recognisably one of the permitted schemes is blocked.
 *
 * Deliberately no DOM or native imports, so this is unit-testable in isolation and can be shared by a
 * "use dom" bundle and the native side alike.
 */

import { EXTERNAL_LINK_PROTOCOLS } from "@/components/textEditor/linkUtils"

/**
 * What a preview should do with one link.
 *
 * - `internal` — a pure `#fragment`, resolved without leaving the page, so it is left alone.
 * - `external` — an allowlisted user-navigable scheme. Handed to the OS, never navigated in the
 *   preview WebView.
 * - `block` — everything else. The href is removed so the anchor renders as inert text.
 */
export type UntrustedLinkClassification = { action: "internal" } | { action: "external"; url: string } | { action: "block" }

/**
 * True when the value contains any whitespace or control character.
 *
 * Written as a scan rather than a regex because a control-character class trips `no-control-regex`,
 * and suppressing that rule inside a security check is worse than spelling the ranges out.
 */
function hasInteriorWhitespaceOrControl(url: string): boolean {
	if (/\s/.test(url)) {
		return true
	}

	for (let index = 0; index < url.length; index++) {
		const code = url.charCodeAt(index)

		// C0 controls and DEL, plus the C1 range.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return true
		}
	}

	return false
}

/**
 * Classify one raw href value.
 *
 * `url` keeps its original casing — paths, query strings and tokens are case-sensitive (signed URLs,
 * reset tokens); only the scheme test is case-insensitive. Mirrors classifyExternalLinkHref.
 */
export function classifyUntrustedLinkHref(raw: string | null | undefined): UntrustedLinkClassification {
	if (typeof raw !== "string") {
		return {
			action: "block"
		}
	}

	const url = raw.trim()

	if (url.length === 0) {
		return {
			action: "block"
		}
	}

	// No interior whitespace or control characters, checked BEFORE the scheme allowlist.
	//
	// The allowlist is a prefix test, so without this a value that merely STARTS with an allowlisted
	// scheme carries whatever follows — `tel:+1\njavascript:...` passes `startsWith("tel:")` and the
	// whole string is what reaches Linking.openURL. The OS resolves by the leading scheme so the tail
	// is inert, but handing the platform a URL containing raw control characters is not something to
	// rely on being harmless. A legitimate href has no interior control characters: a real space is
	// %20 by the time it is a URL.
	if (hasInteriorWhitespaceOrControl(url)) {
		return {
			action: "block"
		}
	}

	// A pure fragment. Checked before the scheme allowlist because `#...` carries no scheme at all.
	// Anything after the `#` is inert by construction — the browser treats the whole value as a
	// fragment identifier, so `#javascript:alert(1)` navigates nowhere and executes nothing.
	if (url.startsWith("#")) {
		return {
			action: "internal"
		}
	}

	const lower = url.toLowerCase()

	if (EXTERNAL_LINK_PROTOCOLS.some(protocol => lower.startsWith(protocol))) {
		return {
			action: "external",
			url
		}
	}

	// Default deny. Covers javascript:, data:, file:, content:, intent:, blob:, ftp: (which pdf.js
	// itself permits and we do not), relative paths, and anything obfuscated enough to miss the
	// allowlist.
	return {
		action: "block"
	}
}
