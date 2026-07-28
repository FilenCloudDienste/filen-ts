/**
 * Pure link handling for the .docx preview.
 *
 * `docx-preview` copies a hyperlink relationship's `Target` verbatim into the rendered anchor's
 * href with no protocol check (`renderHyperlink`), so a crafted document can put ANY scheme —
 * including `javascript:` — into the preview DOM. The preview runs in a WebView whose page origin
 * is the DOM bundle, so a tapped `javascript:` link executes attacker-controlled script in that
 * origin. This module decides, for every href the library produced, whether it may stay a link.
 *
 * ALLOWLIST, never a denylist. A `javascript:`-matching denylist is bypassable — browsers strip
 * embedded tabs/newlines and leading control characters while parsing a URL, so `java\tscript:x`
 * and `\x01javascript:x` both navigate but neither matches a naive prefix test. An allowlist fails
 * those closed: anything that is not recognisably one of the permitted schemes is blocked.
 *
 * Deliberately no DOM / native imports so this is unit-testable in isolation, and so the "use dom"
 * bundle and the native side can share one definition of the envelope below.
 */

import { EXTERNAL_LINK_PROTOCOLS } from "@/components/textEditor/linkUtils"

/**
 * What the preview should do with one anchor.
 *
 * - `internal` — a pure `#fragment`. `renderHyperlink` emits these for in-document bookmarks
 *   (TOC entries, cross references); the browser resolves them without leaving the page, so they
 *   are left completely alone.
 * - `external` — an allowlisted user-navigable scheme. Handed to the OS, never navigated in the
 *   preview WebView.
 * - `block` — everything else. The href is removed so the anchor renders as inert text.
 */
export type DocxLinkClassification = { action: "internal" } | { action: "external"; url: string } | { action: "block" }

/**
 * True when the value contains any whitespace or control character.
 *
 * Written as a scan rather than a regex because a control-character class trips `no-control-regex`,
 * and suppressing that rule in a security check is worse than spelling the ranges out.
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
 * Classify one raw href attribute value.
 *
 * `url` keeps its original casing — paths, query strings and tokens are case-sensitive (signed
 * URLs, reset tokens); only the scheme test is case-insensitive. Mirrors classifyExternalLinkHref.
 */
export function classifyDocxLinkHref(raw: string | null | undefined): DocxLinkClassification {
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

	// Default deny. Covers javascript:, data:, file:, content:, intent:, blob:, relative paths and
	// anything obfuscated enough to miss the allowlist.
	return {
		action: "block"
	}
}

/**
 * Marks an anchor the sweep has already resolved to an allowlisted external URL. The click handler
 * reads the URL from here rather than re-reading `href`, because the sweep rewrites `href` to "#"
 * to keep the anchor styled as a link without letting the WebView navigate to it.
 */
export const DOCX_EXTERNAL_URL_ATTRIBUTE = "data-external-url"

export const DOCX_EXTERNAL_LINK_KEY = "__filenDocxExternalLink"

/**
 * WebView → native envelope for "the user tapped an external link". Key-tagged in the same style as
 * the console proxy's DomLogEnvelope so one `onMessage` can demultiplex both without ambiguity.
 */
export type DocxExternalLinkEnvelope = {
	[DOCX_EXTERNAL_LINK_KEY]: {
		url: string
	}
}

/**
 * Native-side parser for the envelope above. Returns the URL, or null when `parsed` is any other
 * message. Re-classifies rather than trusting the payload: the WebView is the untrusted side of
 * this boundary, and the value reaches Linking.openURL.
 */
export function parseDocxExternalLink(parsed: unknown): string | null {
	if (typeof parsed !== "object" || parsed === null || !(DOCX_EXTERNAL_LINK_KEY in parsed)) {
		return null
	}

	const envelope = (parsed as DocxExternalLinkEnvelope)[DOCX_EXTERNAL_LINK_KEY]

	if (typeof envelope !== "object" || envelope === null) {
		return null
	}

	const classification = classifyDocxLinkHref(envelope.url)

	return classification.action === "external" ? classification.url : null
}

/**
 * Rewrite every anchor the library produced so none of them can navigate this WebView.
 *
 * Kept here rather than in the "use dom" component so it is unit-testable against a real DOM.
 */
export function hardenDocxAnchors(root: ParentNode): void {
	for (const anchor of Array.from(root.querySelectorAll("a"))) {
		const classification = classifyDocxLinkHref(anchor.getAttribute("href"))

		// Cleared for EVERY anchor, before anything else and regardless of classification: this
		// attribute is the click handler's trusted input, and the handler reads it before it re-checks
		// the href. Skipping the clear for internal anchors would leave a document-supplied value in
		// place on a `#fragment` anchor. docx-preview has no attribute passthrough today, so nothing
		// can actually plant one — but the guarantee this attribute carries should not depend on a
		// third-party renderer's current behaviour.
		anchor.removeAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE)

		// In-document bookmark: the browser resolves it without leaving the page.
		if (classification.action === "internal") {
			continue
		}

		if (classification.action === "external") {
			anchor.setAttribute(DOCX_EXTERNAL_URL_ATTRIBUTE, classification.url)

			// Point the href somewhere inert while keeping the element an anchor. The click handler
			// cancels the fragment jump and hands the real URL to the OS, so the preview WebView never
			// navigates. Appearance is unaffected either way: docx-preview emits
			// `.docx a { color: inherit; text-decoration: inherit }`, so a .docx hyperlink is styled by
			// the document's own character style on the run, not by `a:link`.
			anchor.setAttribute("href", "#")

			continue
		}

		// Blocked: no href at all, so it renders as inert text rather than something tappable. This
		// also neutralises every activation route at once — auxclick, middle-click, keyboard and
		// programmatic .click() all need an href to go anywhere.
		anchor.removeAttribute("href")
	}
}

// `url(...)`, matched in three forms so a quote of the OTHER kind inside a quoted target cannot end
// the match early — `url("https://x/?q='")` is legal CSS and a single character class covering both
// quotes plus `)` would stop at the apostrophe and leave the real URL behind.
const CSS_URL_PATTERNS = [/url\(\s*"([^"]*)"\s*\)/gi, /url\(\s*'([^']*)'\s*\)/gi, /url\(\s*([^'")]*?)\s*\)/gi]

// `@import` in either form. The library never emits one, so these are removed outright rather than
// rewritten.
const CSS_IMPORT_PATTERN = /@import[^;]*;?/gi

// A quoted string holding an absolute or protocol-relative URL. Covers the fetch-capable functions
// that take a bare string instead of `url()` — `image-set("https://…" 1x)`, `-webkit-image-set`,
// `cross-fade` — without having to enumerate them.
const CSS_QUOTED_ABSOLUTE_URL_PATTERN = /(['"])\s*(?:[a-z][a-z0-9+.-]*:)?\/\/[^'"]*\1/gi

// The only resource URLs a rendered document legitimately needs. docx-preview inlines every embedded
// image and font from inside the .docx itself (`useBase64URL: true`), so these are the only forms its
// own output produces — verified: its two `url()` emission sites both take a `blobToURL` result.
const ALLOWED_CSS_URL_PREFIXES = ["data:", "blob:"]

function isAllowedCssUrl(target: string): boolean {
	const lower = target.trim().toLowerCase()

	return ALLOWED_CSS_URL_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/**
 * Neutralise outbound resource loads in the stylesheets docx-preview generated.
 *
 * `styleToString` concatenates `<style>` content with NO escaping and many document-controlled values
 * reach it (run colours, shading, theme colours, VML `cssText`, numbering ids, font names), so a
 * crafted document can close the current rule and add its own. The anchor sweep never looks at CSS,
 * so this is a separate path out of the same malicious file.
 *
 * It cannot execute script, but a URL in an injected rule makes the engine fetch from an
 * attacker-chosen host the moment the document opens: a zero-interaction beacon revealing IP, user
 * agent and open time, and the transport for CSS-attribute-selector exfiltration of anything visible
 * in this DOM. Removing the non-`data:`/`blob:` targets removes the transport; every legitimate
 * embedded image and font is `data:` by construction and is left untouched.
 *
 * SCOPE, honestly: this is defence in depth over a text sanitiser, not an airtight boundary. It is
 * applied to the source text, so a target hidden behind CSS ident escaping (`\75 rl(...)`, which the
 * CSS parser resolves to a url token but this does not) can still get through. The airtight fix is a
 * Content-Security-Policy on the DOM bundle (`default-src 'none'; img-src data: blob:`), which no
 * parser trick can evade; it is not in place because the bundle's HTML shell is shared with the note
 * editors, where remote images in markdown are legitimate. Treat this as raising the cost, and keep
 * the CSP as the real answer.
 */
export function hardenDocxStyles(root: ParentNode): void {
	for (const style of Array.from(root.querySelectorAll("style"))) {
		const css = style.textContent

		if (css === null || css.length === 0) {
			continue
		}

		let sanitized = css.replace(CSS_IMPORT_PATTERN, "")

		for (const pattern of CSS_URL_PATTERNS) {
			sanitized = sanitized.replace(pattern, (match: string, target: string) => {
				return isAllowedCssUrl(target) ? match : "none"
			})
		}

		sanitized = sanitized.replace(CSS_QUOTED_ABSOLUTE_URL_PATTERN, "\"\"")

		if (sanitized !== css) {
			style.textContent = sanitized
		}
	}
}

/**
 * Neutralise outbound resource loads in inline `style` attributes.
 *
 * Separate from the `<style>` sweep because it is a separate sink: docx-preview copies a VML shape's
 * `style` attribute STRAIGHT through (`case "style": result.cssStyleText = at.value`, then
 * `setAttribute("style", …)`), so any `<w:pict>` in the document carries an attacker-authored
 * declaration block that never appears in a `<style>` element at all. Every other inline style the
 * library writes goes through `Object.assign(el.style, …)` with a fixed key set.
 *
 * Works through the CSSOM rather than the attribute text: reading `el.style` gives values the CSS
 * parser has already normalised, so escaping and comment tricks that defeat a text scan are resolved
 * before they are inspected. Removing the property re-serialises the attribute without it.
 */
export function hardenDocxInlineStyles(root: ParentNode): void {
	for (const element of Array.from(root.querySelectorAll("[style]"))) {
		const declaration = (element as HTMLElement).style

		if (!declaration) {
			continue
		}

		// Backwards: removeProperty re-indexes, so a forward loop would skip the next property.
		for (let index = declaration.length - 1; index >= 0; index--) {
			const property = declaration.item(index)

			if (!property) {
				continue
			}

			const value = declaration.getPropertyValue(property)

			if (!value || !/url\(|:\/\/|(?:^|[\s,('"])\/\//i.test(value)) {
				continue
			}

			const targets = [...value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map(match => match[2] ?? "")
			const hasDisallowed = targets.length === 0 || targets.some(target => !isAllowedCssUrl(target))

			if (hasDisallowed) {
				declaration.removeProperty(property)
			}
		}
	}
}

/**
 * Everything that must happen to the rendered document before the user can interact with it.
 */
export function hardenDocxDom(root: ParentNode): void {
	hardenDocxAnchors(root)
	hardenDocxStyles(root)
	hardenDocxInlineStyles(root)
}
