import { parseUserAgent, type ParsedUserAgent } from "@filen/shared"

// The page's user agent never changes, so it is parsed once.
let parsed: ParsedUserAgent | null = null

function userAgent(): ParsedUserAgent {
	parsed ??= parseUserAgent(navigator.userAgent)

	return parsed
}

// iOS or iPadOS: a WebKit tab that is killed far sooner than a desktop engine's under memory pressure. iPadOS browsers
// send a Mac's user agent by default; no Mac reports touch points.
export function isAppleMobile(): boolean {
	const os = userAgent().os

	return os === "iOS" || os === "iPadOS" || (os === "macOS" && navigator.maxTouchPoints > 1)
}

// The WebKit engine: Safari, and every browser on iOS and iPadOS.
export function isWebKitEngine(): boolean {
	return isAppleMobile() || userAgent().browser === "Safari"
}
