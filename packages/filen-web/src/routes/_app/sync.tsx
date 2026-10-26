import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { desktopBridge } from "@/lib/desktop"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

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

function SyncLayout() {
	return <Outlet />
}
