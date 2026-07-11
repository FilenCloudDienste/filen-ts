import { Outlet, useRouterState } from "@tanstack/react-router"
import { IconRail } from "@/features/shell/components/iconRail"
import { DriveSidebar } from "@/features/shell/components/driveSidebar"
import { NotesSidebar } from "@/features/notes/components/notesSidebar"
import { SystemStrip } from "@/features/shell/components/systemStrip"
import { AccountReminders } from "@/features/shell/components/accountReminders"
import { SyncHost } from "@/features/notes/components/syncHost"
import { SocketHost } from "@/features/shell/components/socketHost"

// Padded canvas holding the three shell zones: a bare icon rail sitting directly on the canvas, then
// two floating rounded panels — the contextual module sidebar and the content card. Nothing touches a
// viewport edge; zones separate through the canvas gaps themselves, never a border line. The sidebar
// is Drive-specific for now (only one module exists) and becomes contextual as other modules land.
//
// SystemStrip sits ABOVE the padded row: in a plain browser it renders null and the column collapses
// to exactly the row below. Under Electron it adds its own height on top instead of eating into the
// page padding — the row gets `min-h-0 flex-1` so it never has to know the strip exists.
export function AppShell() {
	// The sidebar panel is contextual (fulfilling this shell's own "becomes contextual as other modules
	// land" note): /notes* gets the NotesSidebar, everything else the DriveSidebar. Both share the same
	// panel geometry (w-52, rounded-xl, borderless), so the switch is invisible to the surrounding layout.
	const pathname = useRouterState({ select: state => state.location.pathname })
	const onNotes = pathname === "/notes" || pathname.startsWith("/notes/")

	return (
		<div className="flex h-svh w-full flex-col overflow-hidden bg-canvas text-foreground">
			<AccountReminders />
			{/* Notes sync outbox driver — mounted once in the authed shell so a pending edit flushes even
			    while the user is on drive, not scoped to the notes route. Renders nothing. */}
			<SyncHost />
			{/* Realtime socket bridge — one subscription for the whole authed session; registers the note
			    domain's handlers (drive/chats reuse the bridge later). Renders nothing. */}
			<SocketHost />
			<SystemStrip />
			<div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
				<IconRail />
				{onNotes ? <NotesSidebar /> : <DriveSidebar />}
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-sm">
					<Outlet />
				</main>
			</div>
		</div>
	)
}
