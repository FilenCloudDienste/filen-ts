import { useEffect, useState, type ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router"
import { IconRail } from "@/features/shell/components/iconRail"
import { SidebarDrawer } from "@/features/shell/components/sidebarDrawer"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { resolveSidebarKind, SIDEBAR_LABEL_KEY, type SidebarKind } from "@/features/shell/lib/appShell.logic"
import { subscribeToLayoutBreakpoint } from "@/features/shell/lib/breakpoints"
import { SidebarPanelVisibilityProvider } from "@/features/shell/lib/sidebarPanelVisibility"
import { DriveSidebar } from "@/features/shell/components/driveSidebar"
import { NotesSidebar } from "@/features/notes/components/notesSidebar"
import { ChatsSidebar } from "@/features/chats/components/chatsSidebar"
import { SettingsSidebar } from "@/features/settings/components/settingsSidebar"
import { ContactsSidebar } from "@/features/contacts/components/contactsSidebar"
import { PlaylistsSidebar } from "@/features/audio/components/playlistsSidebar"
import { VideosSidebar } from "@/features/videos/components/videosSidebar"
import { SyncSidebar } from "@/features/sync/components/syncSidebar"
import { MountsSidebar } from "@/features/mounts/components/mountsSidebar"
import { AccountReminders } from "@/features/shell/components/accountReminders"
import { SyncHost } from "@/features/notes/components/syncHost"
import { ChatsSyncHost } from "@/features/chats/components/syncHost"
import { SocketHost } from "@/features/shell/components/socketHost"
import { AudioPlayerBar } from "@/features/audio/components/audioPlayerBar"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { AssistantDrawer, AssistantSidePanel } from "@/features/assistant/components/assistantPanel"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { AssistantNavigationBridge } from "@/features/assistant/tools/navigationBridge"
import { DesktopHost } from "@/features/desktop/components/desktopHost"
import { desktopBridge } from "@/lib/desktop"

const SIDEBAR_PANEL: Record<SidebarKind, ComponentType> = {
	chats: ChatsSidebar,
	notes: NotesSidebar,
	settings: SettingsSidebar,
	contacts: ContactsSidebar,
	playlists: PlaylistsSidebar,
	videos: VideosSidebar,
	sync: SyncSidebar,
	mounts: MountsSidebar,
	drive: DriveSidebar
}

// The bridge never appears or disappears mid-session.
const IS_DESKTOP = desktopBridge() !== undefined

// Padded canvas holding the shell zones: a bare icon rail sitting directly on the canvas, then floating
// rounded panels — the contextual module sidebar, the content card and, when open, the assistant panel on
// the right. Nothing touches a viewport edge; zones separate through the canvas gaps, each panel outlined by
// --shell-border. The sidebar is contextual per module (see resolveSidebarKind).
//
// Below the app's layout breakpoint the row cannot hold the sidebar at all, so the shell RELOCATES it
// into a left drawer reached from the rail's one trigger — collapsing chrome never means deleting it.
// The panel has exactly one mount either way: inline in the row at desktop widths, inside the drawer
// portal below them.
//
// The title-bar band sits ABOVE the padded row. It has a height only where the desktop shell's
// window-controls overlay (Windows, Linux) defines titlebar-area-height, and is 0 in a browser and on macOS,
// so the row gets `min-h-0 flex-1` and never has to know the band exists.
export function AppShell() {
	// The sidebar panel is contextual: /chats* gets the ChatsSidebar, /notes* the NotesSidebar,
	// /settings* the SettingsSidebar, /contacts the ContactsSidebar, /playlists the PlaylistsSidebar,
	// /videos* the VideosSidebar, /sync* the SyncSidebar, /mounts* the MountsSidebar, everything else the
	// DriveSidebar. All nine share the same panel styling (rounded-xl, --shell-border outline); drive, notes,
	// chats, playlists, videos, sync and mounts are user-resizable (useResizableSidebar) and render a trailing
	// drag-handle sibling — settings and contacts stay fixed at w-52.
	const { t } = useTranslation("common")
	const router = useRouter()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const sidebarKind = resolveSidebarKind(pathname)
	const Panel = SIDEBAR_PANEL[sidebarKind]
	const narrow = useIsNarrowViewport()
	const [sidebarOpen, setSidebarOpen] = useState(false)
	const assistantPanelOpen = useAssistantStore(state => state.panelOpen)
	const assistantDrawerOpen = useAssistantStore(state => state.drawerOpen)

	useDismissBootSplash()

	// The panel is mounted either way (inline in the row, or inside the closed drawer behind display:none),
	// so the panels themselves cannot tell whether anyone can see them — this is the shell's answer to
	// that, and it is what keeps a hidden panel's document-level shortcuts from acting on it.
	const sidebar = (
		<SidebarPanelVisibilityProvider visible={!narrow || sidebarOpen}>
			<Panel />
		</SidebarPanelVisibilityProvider>
	)

	// The drawers must survive neither a navigation (one would cover the result it just navigated to,
	// including a route the assistant opened) nor a trip across the layout breakpoint: `open` is gated on
	// `narrow`, but the state behind it is not, so a stale `true` sits invisible at desktop widths and
	// re-opens the drawer by itself the moment the window narrows again. Both signals are read as external
	// subscriptions rather than by diffing state in an effect body.
	useEffect(() => {
		function close(): void {
			setSidebarOpen(false)

			if (useAssistantStore.getState().drawerOpen) {
				useAssistantStore.getState().setDrawerOpen(false)
			}
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
			{/* The assistant's navigation tools act through the router from here, whether or not the panel is
			    open. Renders nothing. */}
			<AssistantNavigationBridge />
			{IS_DESKTOP ? <DesktopHost /> : null}
			<div className="h-[env(titlebar-area-height,0px)] shrink-0 app-region-drag" />
			{/* A sibling of the row, never its wrapper (see sidebarDrawer.tsx); the panel goes to exactly one
			    of the two slots. */}
			<SidebarDrawer
				open={narrow && sidebarOpen}
				narrow={narrow}
				label={t(SIDEBAR_LABEL_KEY[sidebarKind])}
				panel={sidebar}
				onOpenChange={setSidebarOpen}
			/>
			<AssistantDrawer
				open={narrow && assistantDrawerOpen}
				narrow={narrow}
			/>
			<div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2 app-region-drag">
				<IconRail />
				{/* Positioning context for the sidebar's drag handle, which sits absolutely in the gap-2
				    after the panel (see sidebarResizeHandle.tsx) — an in-flow handle would add a second
				    gap and make the sidebar-to-main spacing wider than the row's padding. */}
				{narrow ? null : <div className="relative flex shrink-0">{sidebar}</div>}
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-shell-border bg-card shadow-sm app-region-pane">
					<Outlet />
				</main>
				{/* The assistant panel mirrors the sidebar slot on the right: the wrapper positions its
				    leading-edge drag handle in the gap before it. Below the breakpoint it lives in its drawer. */}
				{narrow || !assistantPanelOpen ? null : (
					<div className="relative flex shrink-0">
						<AssistantSidePanel />
					</div>
				)}
			</div>
			{/* Persistent audio player — docked at the bottom of the authed shell, below the module row, the
			    same shell-level docking the transfers rail established. Renders null until a queue exists;
			    since AppShell is the authed layout (public-link routes have their own tree), the player is
			    inherently authed-only. */}
			<AudioPlayerBar />
		</div>
	)
}
