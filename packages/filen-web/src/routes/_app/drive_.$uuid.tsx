import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/components/drive/directory-listing"

// Trailing-underscore flat sibling of drive.tsx: drive.tsx is a leaf route (no Outlet), so this
// route deliberately does NOT nest under it — the trailing underscore on "drive_" tells the
// router-generator to flatten instead of requiring drive.tsx to host an Outlet, producing the plain
// path /drive/$uuid.
export const Route = createFileRoute("/_app/drive_/$uuid")({ component: DriveDirectoryPage })

function DriveDirectoryPage() {
	const { uuid } = Route.useParams()

	return (
		<DirectoryListing
			variant="drive"
			uuid={uuid}
		/>
	)
}
