import { classifyNavigation } from "./navigation.ts"

// Electron grants every permission unless told otherwise; only what the web app uses is allowed, and only to
// the app itself: clipboard (copy, paste), fullscreen (video), persistent storage (OPFS), wake lock (media) and
// fileSystem (the save picker downloads use).
const ALLOWED = new Set<string>([
	"clipboard-read",
	"clipboard-sanitized-write",
	"fullscreen",
	"persistent-storage",
	"screen-wake-lock",
	"fileSystem"
])

export function isPermissionAllowed(permission: string, requestingUrl: string, appOrigin: string): boolean {
	return ALLOWED.has(permission) && classifyNavigation(requestingUrl, appOrigin) === "inApp"
}
