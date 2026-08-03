import { isSafeLinkHref } from "@/features/preview/components/docxViewer.logic"

// A notice's repository string is copied verbatim out of the dependency's own manifest, so the shipped
// payload carries plain https URLs next to git:/ssh:/git+https: ones and npm's bare "owner/repo"
// shorthand. Only a value the browser can actually open becomes an anchor; everything else renders as
// plain text, which is both the honest presentation and the reason this never has to trust a manifest
// with what goes into an href.
export function noticeRepositoryHref(repository: string | null): string | null {
	if (repository === null || !isSafeLinkHref(repository)) {
		return null
	}

	try {
		// isSafeLinkHref resolves a relative reference against a base, so the bare shorthand passes it —
		// parsing WITHOUT a base is what rejects those, which would otherwise navigate inside the app. The
		// http(s) narrowing then drops mailto:, which that shared allowlist permits but a repository link
		// has no business being.
		const url = new URL(repository)

		return url.protocol === "http:" || url.protocol === "https:" ? repository : null
	} catch {
		return null
	}
}
