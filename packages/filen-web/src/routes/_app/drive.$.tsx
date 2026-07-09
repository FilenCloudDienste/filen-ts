import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

// Full-path splat, mirroring old web's own drive.$.tsx: `_splat` is the "/"-joined ancestor-uuid
// chain with no leading/trailing slash. An empty splat matches bare /drive (My Drive root); a
// nested "a/b/c" is three directories deep. The current directory is always the last segment
// (see features/drive/lib/navigate.ts's splatToUuids). Replaces the old flat drive.tsx + trailing-underscore
// drive_.$uuid.tsx pair — one route now covers every depth, so the breadcrumb/navigate layer can
// build straight off the URL instead of a getItemPath walk.
export const Route = createFileRoute("/_app/drive/$")({ component: DrivePage })

function DrivePage() {
	const { _splat } = Route.useParams()

	return (
		<DirectoryListing
			variant="drive"
			splat={_splat ?? ""}
		/>
	)
}
