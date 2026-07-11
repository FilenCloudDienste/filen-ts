import { createFileRoute, Outlet } from "@tanstack/react-router"

// Settings layout parent (D3): flat-file routing nests every section route (index/account/security/
// appearance/events/billing) under this Outlet. The sidebar itself lives in the shell (SettingsSidebar,
// mounted by appShell.tsx's own /settings* switch), not here — same split as chats/notes' own layout
// routes. Auth-guarded by the _app layout; holds no chrome of its own.
export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout })

function SettingsLayout() {
	return <Outlet />
}
