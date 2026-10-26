import { classifyLink } from "@filen/shared/linkPolicy"

export type NavigationVerdict = "inApp" | "external" | "deny"

// The OS opens web and mail links only: links here can come from content other people wrote (chats, notes,
// documents), and the remaining schemes the shared link policy allows would hand them to arbitrary local apps.
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"])

// Our own origin stays in the window; web and mail links go to the OS; the rest is refused.
export function classifyNavigation(url: string, appOrigin: string): NavigationVerdict {
	let origin: string

	// Node's URL reports "null" as the origin of a non-special scheme like filen:, so build it.
	try {
		const parsed = new URL(url)

		origin = `${parsed.protocol}//${parsed.host}`
	} catch {
		return "deny"
	}

	if (origin === appOrigin) {
		return "inApp"
	}

	const verdict = classifyLink(url)

	return verdict.kind === "external" && EXTERNAL_SCHEMES.has(verdict.scheme) ? "external" : "deny"
}

// IPC is answered only for the app's own top-level document, never for another origin a frame was navigated to.
export function isTrustedSender(senderUrl: string | undefined, appOrigin: string): boolean {
	return senderUrl !== undefined && classifyNavigation(senderUrl, appOrigin) === "inApp"
}
