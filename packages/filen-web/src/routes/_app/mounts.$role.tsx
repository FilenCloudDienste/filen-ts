import { useEffect } from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { rememberLastOpened } from "@/features/shell/lib/lastOpened"
import { isOfferedRole } from "@/features/mounts/lib/mountsRoles"
import { desktopPlatform } from "@/lib/desktop"
import { DrivePage } from "@/features/mounts/components/drivePage"
import { ServePage } from "@/features/mounts/components/servePage"

// One Mounts page: `role` is "drive" (the network drive) or a serve protocol. A role this platform does not
// offer (a typo, nfs on Windows) lands on the index.
export const Route = createFileRoute("/_app/mounts/$role")({
	beforeLoad: ({ params }) => {
		if (!isOfferedRole(params.role, desktopPlatform())) {
			throw redirect({ to: "/mounts", replace: true })
		}
	},
	component: MountsRolePage
})

// Keyed: nothing one server's page holds (drafts, shown credentials, dialogs) carries over to the next. An offered
// role becomes the one bare /mounts reopens.
function MountsRolePage() {
	const { role } = Route.useParams()
	const offered = isOfferedRole(role, desktopPlatform())

	useEffect(() => {
		if (offered) {
			rememberLastOpened("mounts", role)
		}
	}, [offered, role])

	if (!isOfferedRole(role, desktopPlatform())) {
		return null
	}

	return role === "drive" ? (
		<DrivePage />
	) : (
		<ServePage
			key={role}
			protocol={role}
		/>
	)
}
