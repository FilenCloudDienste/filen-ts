import { useEffect, useRef } from "react"
import { inspectRouteLink, type PublicLinkKind } from "@/features/publicLinks/lib/format.logic"
import { clearPreviewCache } from "@/features/preview/lib/previewCache"
import { ArchiveListingScope } from "@/features/archive/components/archiveListingScope"
import { PublicLinkShell } from "@/features/publicLinks/components/publicLinkShell"
import { PublicLinkInvalid } from "@/features/publicLinks/components/publicLinkStates"
import { FileLinkView } from "@/features/publicLinks/components/fileLinkView"
import { DirectoryLinkView } from "@/features/publicLinks/components/directoryLinkView"
import { EMPTY_REPORT_SUBJECT, ReportSubjectContext } from "@/features/publicLinks/lib/reportSubject"
import type { ReportSubject } from "@/features/publicLinks/lib/report.logic"

// The UNAUTHENTICATED public-link viewer. Rendered by both /f/ (file) and /d/ (dir), gated ONLY by the
// root BootGate (no auth redirect either way), so an anonymous visitor and a signed-in visitor both
// land here. inspectRouteLink pulls the uuid from the path param and the decryption key from the URL
// FRAGMENT (window.location.hash) — the key never leaves the fragment/memory: it is not in the route
// path, not logged, and every query below keeps it out of the query key (queries/publicLink.ts). An
// unresolvable fragment (bad uuid / bad-or-short key) short-circuits to the invalid surface with no
// round trip; the shared shell wraps every state.
export function PublicLinkView({ kind, uuid }: { kind: PublicLinkKind; uuid: string }) {
	// The fragment is client-side only and fixed for a mounted view (a different link is a fresh
	// navigation), so reading it straight off the live location is sufficient.
	const hash = typeof window === "undefined" ? "" : window.location.hash
	const resolved = inspectRouteLink(uuid, hash)
	// What an abuse report from the shell's footer says the visitor is on, written by the views below.
	const reportSubjectRef = useRef<ReportSubject>(EMPTY_REPORT_SUBJECT)

	// The preview buffers this link loaded stay only while it is open: leaving it (Back, sign-in, Open
	// Cloud Drive, another link) drops them. Hiding a preview keeps them for a Download or a revisit.
	useEffect(() => {
		return () => {
			clearPreviewCache()
		}
	}, [uuid])

	// The archive listings a signed-in visitor browsed live as long as the link: hiding the contents or
	// stepping between a directory link's files reopens them, and another link starts without them.
	return (
		<ReportSubjectContext value={reportSubjectRef}>
			<PublicLinkShell>
				<ArchiveListingScope key={uuid}>
					{resolved.status === "invalid" ? (
						<PublicLinkInvalid />
					) : resolved.status === "incomplete" ? (
						<PublicLinkInvalid reason="incomplete" />
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
				</ArchiveListingScope>
			</PublicLinkShell>
		</ReportSubjectContext>
	)
}
