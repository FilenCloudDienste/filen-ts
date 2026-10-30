import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { readLastOpened, useLastOpened } from "@/features/shell/lib/lastOpened"
import { mountsIndexRedirectTarget } from "@/features/mounts/lib/indexRedirect.logic"
import { MOUNTS_OFFER } from "@/features/mounts/lib/mountsOffer"
import { MountsOverview } from "@/features/mounts/components/mountsOverview"
import { LoadingState } from "@/components/loadingState"

// The bare /mounts index, under the mounts layout's desktop guard: the overview of Filen in Finder (where offered), the
// drive and every server. Like Notes and Chats it reopens the last opened page (the rail links here) unless that was
// the overview itself, which the sidebar's Overview row records. The loader warms the stored value so the decision
// needs no extra render.
export const Route = createFileRoute("/_app/mounts/")({
	loader: async () => {
		await readLastOpened("mounts")
	},
	component: MountsIndexPage
})

function MountsIndexPage() {
	const navigate = useNavigate()
	const target = mountsIndexRedirectTarget(useLastOpened("mounts"), MOUNTS_OFFER)

	useEffect(() => {
		if (typeof target === "string") {
			void navigate({ to: "/mounts/$role", params: { role: target }, replace: true })
		}
	}, [target, navigate])

	return target === null ? <MountsOverview /> : <LoadingState size="lg" />
}
