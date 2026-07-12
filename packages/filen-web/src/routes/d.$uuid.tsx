import { createFileRoute } from "@tanstack/react-router"
import { PublicLinkView } from "@/features/publicLinks/components/publicLinkView"

// UNAUTHENTICATED public-link viewer — DIRECTORY. A top-level route (sibling of /login), gated ONLY by
// the root BootGate: no beforeLoad auth logic in either direction, so an anonymous visitor AND a
// signed-in visitor both see the viewer. NEW format semantics: /d/ = directory (deliberately swapped
// from the legacy hash-router convention where /d/ meant a file — the legacy shape still works via the
// index route's redirect). The decryption key rides the URL fragment (#<key>), read client-side, never
// sent to any server.
export const Route = createFileRoute("/d/$uuid")({
	component: DirectoryPublicLinkPage
})

function DirectoryPublicLinkPage() {
	const { uuid } = Route.useParams()

	return (
		<PublicLinkView
			kind="directory"
			uuid={uuid}
		/>
	)
}
