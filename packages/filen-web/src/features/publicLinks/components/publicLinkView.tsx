import { useEffect } from "react"
import { resolveRouteLink, type PublicLinkKind } from "@/features/publicLinks/lib/format.logic"
import { clearPreviewCache } from "@/features/preview/lib/previewCache"
import { PublicLinkShell } from "@/features/publicLinks/components/publicLinkShell"
import { PublicLinkInvalid } from "@/features/publicLinks/components/publicLinkStates"
import { FileLinkView } from "@/features/publicLinks/components/fileLinkView"
import { DirectoryLinkView } from "@/features/publicLinks/components/directoryLinkView"

// The UNAUTHENTICATED public-link viewer. Rendered by both /f/ (file) and /d/ (dir), gated ONLY by the
// root BootGate (no auth redirect either way), so an anonymous visitor and a signed-in visitor both
// land here. resolveRouteLink pulls the uuid from the path param and the decryption key from the URL
// FRAGMENT (window.location.hash) — the key never leaves the fragment/memory: it is not in the route
// path, not logged, and every query below keeps it out of the query key (queries/publicLink.ts). An
// unresolvable fragment (bad uuid / bad-or-short key) short-circuits to the invalid surface with no
// round trip; the shared shell wraps every state.
export function PublicLinkView({ kind, uuid }: { kind: PublicLinkKind; uuid: string }) {
	// The fragment is client-side only and fixed for a mounted view (a different link is a fresh
	// navigation), so reading it straight off the live location is sufficient.
	const hash = typeof window === "undefined" ? "" : window.location.hash
	const resolved = resolveRouteLink(uuid, hash)

	// The preview buffers this link loaded stay only while it is open: leaving it (Back, sign-in, Open
	// Cloud Drive, another link) drops them. Hiding a preview keeps them for a Download or a revisit.
	useEffect(() => {
		return () => {
			clearPreviewCache()
		}
	}, [uuid])

	return (
		<PublicLinkShell>
			{resolved === null ? (
				<PublicLinkInvalid />
			) : kind === "file" ? (
				<FileLinkView
					uuid={resolved.uuid}
					linkKey={resolved.key}
				/>
			) : (
				<DirectoryLinkView
					uuid={resolved.uuid}
					linkKey={resolved.key}
				/>
			)}
		</PublicLinkShell>
	)
}
