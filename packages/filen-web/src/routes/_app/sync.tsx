import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { desktopBridge } from "@/lib/desktop"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"
import { closeAddPair, useSyncStore } from "@/features/sync/lib/syncStore"
import { AddPairDialog } from "@/features/sync/components/addPairDialog"

// Sync layout parent: sync.index (/sync) and sync.$pairId (/sync/$pairId) render into its Outlet, the pair
// list lives in the shell's sidebar. Sync runs in the desktop app only, so a browser lands on Drive.
export const Route = createFileRoute("/_app/sync")({
	head: routeHead({ title: () => [i18n.t("common:moduleSync")] }),
	beforeLoad: () => {
		if (desktopBridge() === undefined) {
			throw redirect({ to: "/drive/$", params: { _splat: "" } })
		}
	},
	component: SyncLayout
})

// The add-pair dialog mounts here rather than in the sidebar, which unmounts with the narrow-viewport drawer.
function SyncLayout() {
	const addPairOpen = useSyncStore(state => state.addPairOpen)

	return (
		<>
			<Outlet />
			{addPairOpen ? <AddPairDialog onClose={closeAddPair} /> : null}
		</>
	)
}
