import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

// Full-path splat for the "shared with others" surface, mirroring drive.$.tsx: `_splat` is the
// "/"-joined ancestor-uuid chain with no leading/trailing slash. An empty splat matches bare
// /shared-out (the shared-out root); a nested "a/b" browses that many shares deep. The current
// directory is always the last segment (see features/drive/lib/navigate.ts's splatToUuids). A cold deep-link
// to a nested share has no by-uuid shared-dir resolver (the worker's role cache is in-session only),
// so DirectoryListing's own error state renders rather than a root fallback — mobile's rule.
export const Route = createFileRoute("/_app/shared-out/$")({ component: SharedOutPage })

function SharedOutPage() {
	const { _splat } = Route.useParams()

	return (
		<DirectoryListing
			variant="sharedOut"
			splat={_splat ?? ""}
		/>
	)
}
