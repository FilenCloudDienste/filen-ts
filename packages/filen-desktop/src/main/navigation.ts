import { classifyLink } from "@filen/shared/linkPolicy"

export type NavigationVerdict = "inApp" | "external" | "deny"

// Our own origin stays in the window; anything the shared link policy allows goes to the OS; the rest is refused.
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

	return classifyLink(url).kind === "external" ? "external" : "deny"
}

// IPC is answered only for the app's own top-level document, never for another origin a frame was navigated to.
export function isTrustedSender(senderUrl: string | undefined, appOrigin: string): boolean {
	return senderUrl !== undefined && classifyNavigation(senderUrl, appOrigin) === "inApp"
}
