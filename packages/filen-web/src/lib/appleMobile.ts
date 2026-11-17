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

// A screen's short side at most this many CSS pixels is a phone's: the smallest iPad's is 744.
const PHONE_SHORT_SIDE = 500

// A phone, not a tablet: the smallest tab budgets. An iPhone, or Android whose browser says "Mobile"; or, for a phone
// asking for desktop sites (whose user agent says Mac or Linux), a touch screen with a phone's short side.
export function isPhone(): boolean {
	return userAgent().device === "mobile" || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) <= PHONE_SHORT_SIDE)
}
