import { Outlet } from "@tanstack/react-router"
import { IconRail } from "@/features/shell/components/iconRail"
import { DriveSidebar } from "@/features/shell/components/driveSidebar"
import { useShellStore } from "@/features/shell/store/useShellStore"

// Three-zone shell on one light-gray canvas: a borderless icon rail, the contextual module sidebar,
// and a floating content card holding the route Outlet. Every zone separation is tone/elevation, not
// a border line. The sidebar is Drive-specific for now (only one module exists) and becomes
// contextual as the other modules land; the rail's collapse toggle hides it entirely (state
// persisted), leaving the rail and letting the card widen to fill the freed space.
export function AppShell() {
	const sidebarCollapsed = useShellStore(state => state.sidebarCollapsed)

	return (
		<div className="flex h-svh w-full overflow-hidden bg-canvas text-foreground">
			<IconRail />
			{sidebarCollapsed ? null : <DriveSidebar />}
			<main className="flex min-w-0 flex-1 flex-col overflow-hidden p-2">
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
					<Outlet />
				</div>
			</main>
		</div>
	)
}
