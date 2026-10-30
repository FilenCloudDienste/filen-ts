import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { desktopBridge } from "@/lib/desktop"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"
import { useFollowFileProvider } from "@/features/mounts/lib/fileProviderStore"

// Mounts layout parent: mounts.index (/mounts) and mounts.$role (/mounts/$role) render into its Outlet, the
// role list lives in the shell's sidebar. Mounts run in the desktop app only, so a browser lands on Drive. While it is
// open, Filen in Finder's state is followed (where supported).
export const Route = createFileRoute("/_app/mounts")({
	head: routeHead({ title: () => [i18n.t("common:moduleMounts")] }),
	beforeLoad: () => {
		if (desktopBridge() === undefined) {
			throw redirect({ to: "/drive/$", params: { _splat: "" } })
		}
	},
	component: MountsLayout
})

function MountsLayout() {
	useFollowFileProvider()

	return <Outlet />
}
