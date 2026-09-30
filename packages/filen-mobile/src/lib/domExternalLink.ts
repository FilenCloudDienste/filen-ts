/**
 * WebView -> native "open this link" channel shared by the document previews (PDF, .docx).
 *
 * No DOM or native imports, so a "use dom" bundle and its native host share one definition and it is
 * testable in node.
 */

import { classifyUntrustedLinkHref } from "@/lib/untrustedLinks"

/**
 * Marks an anchor whose href the viewer has already resolved to an allowlisted external URL. The tap
 * handler reads the URL from here rather than from `href`, because `href` is rewritten to "#" so the
 * anchor stays styled as a link without the WebView being able to navigate to it.
 */
export const EXTERNAL_URL_ATTRIBUTE = "data-external-url"

// Key-tagged like the console proxy's envelope so one `onMessage` demultiplexes both. Every preview
// has its own WebView, so one key serves all of them.
export const EXTERNAL_LINK_KEY = "__filenExternalLink"

type ReactNativeWebViewBridge = {
	postMessage: (message: string) => void
}

/**
 * WebView side. The native bridge the DOM runtime injects, or null outside a WebView or before it is
 * injected.
 */
export function getReactNativeWebView(): ReactNativeWebViewBridge | null {
	const rnWebView = (globalThis as unknown as { ReactNativeWebView?: Partial<ReactNativeWebViewBridge> }).ReactNativeWebView

	return rnWebView && typeof rnWebView.postMessage === "function" ? (rnWebView as ReactNativeWebViewBridge) : null
}

/**
 * WebView side. Fire-and-forget post that never throws: it is called from event handlers and from
 * paths that are themselves reporting a failure.
 */
export function postToNativeWebView(message: unknown): void {
	const rnWebView = getReactNativeWebView()

	if (!rnWebView) {
		return
	}

	try {
		rnWebView.postMessage(JSON.stringify(message))
	} catch {
		// Swallowed on purpose, see above.
	}
}

/**
 * WebView side. Hands an allowlisted URL to the native side, which re-validates it and opens it with
 * the OS.
 */
export function postExternalLink(url: string): void {
	postToNativeWebView({
		[EXTERNAL_LINK_KEY]: {
			url
		}
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/**
 * Native side. Returns the URL of a link-tap envelope, or null for any other message. Re-classifies
 * rather than trusting the payload: the WebView is the untrusted side of this bridge, and the value
 * reaches Linking.openURL.
 */
export function parseExternalLinkMessage(parsed: unknown): string | null {
	if (!isRecord(parsed) || !(EXTERNAL_LINK_KEY in parsed)) {
		return null
	}

	const envelope = parsed[EXTERNAL_LINK_KEY]

	if (!isRecord(envelope)) {
		return null
	}

	const classification = classifyUntrustedLinkHref(typeof envelope["url"] === "string" ? envelope["url"] : null)

	return classification.action === "external" ? classification.url : null
}
