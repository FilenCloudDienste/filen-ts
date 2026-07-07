import { createFileRoute } from "@tanstack/react-router"
import { DirectoryListing } from "@/components/drive/directory-listing"

// My Drive root — uuid-less; the query layer resolves it to client.root() (see
// queries/drive.ts's target mapping). Subdirectories live at the trailing-underscore sibling route
// drive_.$uuid.tsx, kept flat rather than nested under this route since this route is a leaf (no
// Outlet) — see that file for why.
export const Route = createFileRoute("/_app/drive")({ component: DrivePage })

function DrivePage() {
	return (
		<DirectoryListing
			variant="drive"
			uuid={null}
		/>
	)
}
