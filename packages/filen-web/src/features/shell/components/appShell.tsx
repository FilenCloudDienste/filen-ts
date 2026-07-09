import { Outlet } from "@tanstack/react-router"
import { IconRail } from "@/features/shell/components/iconRail"
import { DriveSidebar } from "@/features/shell/components/driveSidebar"

// Desktop-first three-column shell: fixed icon rail, contextual module sidebar, and the content
// pane (route Outlet). The sidebar is Drive-specific for now — only one module exists yet; it
// becomes contextual (rendered per active module) as the other modules land. The sidebar collapses
// below `md` (see DriveSidebar) so the rail + content still work on narrow viewports.
export function AppShell() {
	return (
		<div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
			<IconRail />
			<DriveSidebar />
			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<Outlet />
			</main>
		</div>
	)
}
