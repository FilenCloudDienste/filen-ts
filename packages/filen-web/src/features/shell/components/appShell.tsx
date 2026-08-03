import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router"
import { IconRail } from "@/features/shell/components/iconRail"
import { SidebarDrawer } from "@/features/shell/components/sidebarDrawer"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { resolveSidebarKind, SIDEBAR_LABEL_KEY } from "@/features/shell/lib/appShell.logic"
import { subscribeToLayoutBreakpoint } from "@/features/shell/lib/breakpoints"
import { SidebarPanelVisibilityProvider } from "@/features/shell/lib/sidebarPanelVisibility"
import { DriveSidebar } from "@/features/shell/components/driveSidebar"
import { NotesSidebar } from "@/features/notes/components/notesSidebar"
import { ChatsSidebar } from "@/features/chats/components/chatsSidebar"
import { SettingsSidebar } from "@/features/settings/components/settingsSidebar"
import { ContactsSidebar } from "@/features/contacts/components/contactsSidebar"
import { SystemStrip } from "@/features/shell/components/systemStrip"
import { AccountReminders } from "@/features/shell/components/accountReminders"
import { SyncHost } from "@/features/notes/components/syncHost"
import { ChatsSyncHost } from "@/features/chats/components/syncHost"
import { SocketHost } from "@/features/shell/components/socketHost"
import { AudioPlayerBar } from "@/features/audio/components/audioPlayerBar"

// Padded canvas holding the three shell zones: a bare icon rail sitting directly on the canvas, then
// two floating rounded panels — the contextual module sidebar and the content card. Nothing touches a
// viewport edge; zones separate through the canvas gaps themselves, never a border line. The sidebar
// is contextual per module (see resolveSidebarKind).
//
// Below the app's layout breakpoint the row cannot hold the sidebar at all, so the shell RELOCATES it
// into a left drawer reached from the rail's one trigger — collapsing chrome never means deleting it.
// The panel has exactly one mount either way: inline in the row at desktop widths, inside the drawer
// portal below them.
//
// SystemStrip sits ABOVE the padded row: in a plain browser it renders null and the column collapses
// to exactly the row below. Under Electron it adds its own height on top instead of eating into the
// page padding — the row gets `min-h-0 flex-1` so it never has to know the strip exists.
export function AppShell() {
	// The sidebar panel is contextual: /chats* gets the ChatsSidebar, /notes* the NotesSidebar,
	// /settings* the SettingsSidebar, /contacts the ContactsSidebar, everything else the DriveSidebar.
	// All five share the same panel styling (rounded-xl, borderless); DriveSidebar alone is
	// user-resizable today (useResizableSidebar) and renders its own trailing drag-handle sibling
	// inline in this row — settings/contacts stay fixed at w-52.
	const { t } = useTranslation("common")
	const router = useRouter()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const sidebarKind = resolveSidebarKind(pathname)
	const narrow = useIsNarrowViewport()
	const [sidebarOpen, setSidebarOpen] = useState(false)
	// The panel is mounted either way (inline in the row, or inside the closed drawer behind display:none),
	// so the panels themselves cannot tell whether anyone can see them — this is the shell's answer to
	// that, and it is what keeps a hidden panel's document-level shortcuts from acting on it.
	const sidebar = (
		<SidebarPanelVisibilityProvider visible={!narrow || sidebarOpen}>
			{sidebarKind === "chats" ? (
				<ChatsSidebar />
			) : sidebarKind === "notes" ? (
				<NotesSidebar />
			) : sidebarKind === "settings" ? (
				<SettingsSidebar />
			) : sidebarKind === "contacts" ? (
				<ContactsSidebar />
			) : (
				<DriveSidebar />
			)}
		</SidebarPanelVisibilityProvider>
	)

	// The drawer must survive neither a navigation (it would cover the result it just navigated to) nor a
	// trip across the layout breakpoint: `open` is gated on `narrow`, but the state behind it is not, so a
	// stale `true` sits invisible at desktop widths and re-opens the drawer by itself the moment the
	// window narrows again. Both signals are read as external subscriptions rather than by diffing state
	// in an effect body.
	useEffect(() => {
		function close(): void {
			setSidebarOpen(false)
		}

		// The history primitive, not a router event: the router's onBeforeNavigate is never emitted for
		// link navigations in the mounted app (its only emit site runs when history has no subscribers).
		// History fires on every push/replace/pop, which also covers the contacts panel's search-param-only
		// navigations and browser back/forward; closing an already-closed drawer is a no-op.
		const unsubscribeHistory = router.history.subscribe(close)
		const unsubscribeViewport = subscribeToLayoutBreakpoint(close)

		return () => {
			unsubscribeHistory()
			unsubscribeViewport()
		}
	}, [router])

	return (
		<div className="flex h-svh w-full flex-col overflow-hidden bg-canvas text-foreground">
			<AccountReminders />
			{/* Notes sync outbox driver — mounted once in the authed shell so a pending edit flushes even
			    while the user is on drive, not scoped to the notes route. Renders nothing. */}
			<SyncHost />
			{/* Chat send outbox driver — same rationale as the notes SyncHost above: mounted once so a
			    pending chat send flushes even off the chats route. Renders nothing. */}
			<ChatsSyncHost />
			{/* Realtime socket bridge — one subscription for the whole authed session; registers the note
			    domain's handlers (drive/chats reuse the bridge later). Renders nothing. */}
			<SocketHost />
			<SystemStrip />
			{/* Drawer.Root renders no DOM of its own, so wrapping the row leaves its layout untouched at
			    every width; the panel goes to exactly one of the two slots. */}
			<SidebarDrawer
				open={narrow && sidebarOpen}
				narrow={narrow}
				label={t(SIDEBAR_LABEL_KEY[sidebarKind])}
				panel={sidebar}
				onOpenChange={setSidebarOpen}
			>
				<div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
					<IconRail />
					{narrow ? null : sidebar}
					<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-sm">
						<Outlet />
					</main>
				</div>
			</SidebarDrawer>
			{/* Persistent audio player — docked at the bottom of the authed shell, below the module row, the
			    same shell-level docking the transfers rail established. Renders null until a queue exists;
			    since AppShell is the authed layout (public-link routes have their own tree), the player is
			    inherently authed-only. */}
			<AudioPlayerBar />
		</div>
	)
}
