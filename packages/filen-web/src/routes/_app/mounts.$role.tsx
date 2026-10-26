import { createFileRoute, redirect } from "@tanstack/react-router"
import { isOfferedRole } from "@/features/mounts/lib/mountsRoles"
import { desktopPlatform } from "@/lib/desktop"

// One Mounts page: `role` is "drive" (the network drive) or a serve protocol. A role this platform does not
// offer (a typo, nfs on Windows) lands on the index.
export const Route = createFileRoute("/_app/mounts/$role")({
	beforeLoad: ({ params }) => {
		if (!isOfferedRole(params.role, desktopPlatform())) {
			throw redirect({ to: "/mounts", replace: true })
		}
	}
})
