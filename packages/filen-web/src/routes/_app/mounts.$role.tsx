import { useEffect } from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { rememberLastOpened } from "@/features/shell/lib/lastOpened"
import { FINDER_ROLE, isOfferedRole } from "@/features/mounts/lib/mountsRoles"
import { MOUNTS_OFFER } from "@/features/mounts/lib/mountsOffer"
import { DrivePage } from "@/features/mounts/components/drivePage"
import { FinderPage } from "@/features/mounts/components/finderPage"
import { ServePage } from "@/features/mounts/components/servePage"

// One Mounts page: `role` is "finder" (Filen in Finder), "drive" (the network drive) or a serve protocol. A role this
// app does not offer (a typo, nfs on Windows, Filen in Finder off macOS 14) lands on the index.
export const Route = createFileRoute("/_app/mounts/$role")({
	beforeLoad: ({ params }) => {
		if (!isOfferedRole(params.role, MOUNTS_OFFER)) {
			throw redirect({ to: "/mounts", replace: true })
		}
	},
	component: MountsRolePage
})

// Keyed: nothing one server's page holds (drafts, shown credentials, dialogs) carries over to the next. An offered
// role becomes the one bare /mounts reopens.
function MountsRolePage() {
	const { role } = Route.useParams()
	const offered = isOfferedRole(role, MOUNTS_OFFER)

	useEffect(() => {
		if (offered) {
			rememberLastOpened("mounts", role)
		}
	}, [offered, role])

	if (!isOfferedRole(role, MOUNTS_OFFER)) {
		return null
	}

	if (role === FINDER_ROLE) {
		return <FinderPage />
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
