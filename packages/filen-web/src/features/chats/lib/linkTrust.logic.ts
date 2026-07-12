import { parseFilenPublicLink } from "@/features/chats/lib/embeds.logic"

// Per-domain trust confirmation for a chat message's plain link, before it's ever opened in a new tab.
// Scoped to EXTERNAL links only: a Filen public link (parseFilenPublicLink matches) is this
// app's own domain — already implicitly trusted, resolved through the authenticated in-app client, and
// never opened as a bare external navigation by the embed renderer (filenLinkCard.tsx) either — so it
// is excluded here rather than ever entering the confirm flow.
//
// Returns the lowercased hostname to confirm against, or null when no confirmation is warranted (a
// Filen link, or a url too malformed to have a stable domain identity in the first place — hardenLinkHref
// already excludes non-http(s) schemes upstream, so a null here is effectively unreachable in practice,
// but this stays a total function rather than assuming that invariant).
export function externalLinkDomain(url: string): string | null {
	if (parseFilenPublicLink(url) !== null) {
		return null
	}

	try {
		return new URL(url).hostname.toLowerCase()
	} catch {
		return null
	}
}

// The click-interception decision itself, pulled out of trustedExternalLink.tsx so it's unit-testable
// without mounting the dialog (mirrors previewOverlay.logic.ts's own split). True means: preventDefault
// the anchor's native navigation and show the confirmation instead of opening immediately. A null
// domain (no confirmation possible — externalLinkDomain's own doc comment) never intercepts, same as an
// already-trusted domain.
export function shouldInterceptLinkClick(domain: string | null, trustedDomains: ReadonlySet<string>): boolean {
	return domain !== null && !trustedDomains.has(domain)
}
