import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Full-path splat for the "shared with me" surface, mirroring drive.$.tsx: `_splat` is the
// "/"-joined ancestor-uuid chain with no leading/trailing slash. An empty splat matches bare
// /shared-in (the shared-in root); a nested "a/b" browses that many shares deep. The current
// directory is always the last segment (see features/drive/lib/navigate.ts's splatToUuids). A cold
// deep-link re-walks that chain to reseed the worker's in-session share context, so
// DirectoryListing's error state now only renders for a share that genuinely no longer resolves.
export const Route = createFileRoute("/_app/shared-in/$")({
	head: routeHead({ title: () => [i18n.t("common:driveSharedIn")] }),
	component: SharedInPage
})

function SharedInPage() {
	const { _splat } = Route.useParams()

	return (
		<DirectoryListing
			variant="sharedIn"
			splat={_splat ?? ""}
		/>
	)
}
