import { parseUserAgent } from "@filen/shared"

// iOS or iPadOS: a WebKit tab that is killed far sooner than a desktop engine's under memory pressure. iPadOS browsers
// send a Mac's user agent by default; no Mac reports touch points.
export function isAppleMobile(): boolean {
	const os = parseUserAgent(navigator.userAgent).os

	return os === "iOS" || os === "iPadOS" || (os === "macOS" && navigator.maxTouchPoints > 1)
}

// The WebKit engine: Safari, and every browser on iOS and iPadOS.
export function isWebKitEngine(): boolean {
	return isAppleMobile() || parseUserAgent(navigator.userAgent).browser === "Safari"
}
