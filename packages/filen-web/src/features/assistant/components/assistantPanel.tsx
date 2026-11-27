import { useSyncExternalStore, type CSSProperties, type KeyboardEvent, type Ref } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { isImeKeydown } from "@filen/shared/keymap"
import { SIDE_PANEL_SURFACE_CLASS, SidePanelDrawer } from "@/components/sidePanel"
import { toastSideObstructionRef } from "@/lib/toastClearance"
import { dialogLayerOf, isAnyMenuOpen, KEY_LAYER_PROPS } from "@/lib/keymap/dialogGuard"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { useResizableSidebar } from "@/features/shell/hooks/useResizableSidebar"
import { SidebarResizeHandle } from "@/features/shell/components/sidebarResizeHandle"
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@/features/shell/lib/sidebarWidth"
import { SidebarPanelVisibilityProvider } from "@/features/shell/lib/sidebarPanelVisibility"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { useAssistantHidden } from "@/features/assistant/store/assistantHidden"
import { modelAcceptsMessages, trackAssistantPanelShown } from "@/features/assistant/store/assistantSession"
import { AssistantHeader } from "@/features/assistant/components/assistantHeader"
import { AssistantSetup } from "@/features/assistant/components/assistantSetup"
import { AssistantConversation } from "@/features/assistant/components/assistantConversation"
import { AssistantHistory } from "@/features/assistant/components/assistantHistory"
import { useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import {
	ASSISTANT_PANEL_ID,
	ASSISTANT_PREVIEW_HOST_ID,
	ASSISTANT_TITLE_ID,
	assistantInitialFocusTarget,
	moveFocusOutOfAssistant
} from "@/features/assistant/components/assistantFocus"

// The shared side-panel surface (sidePanel.tsx). tabIndex -1 makes the panel itself the focus fallback when it holds
// no focusable control yet. A key layer of its own: a key pressed in it is never an editor's beside it (the preview
// overlay's viewer, a note), whose keys otherwise follow focus anywhere in their layer.

function AssistantSurface({
	className,
	style,
	ref,
	onClose
}: {
	className: string
	style?: CSSProperties
	ref?: Ref<HTMLElement>
	onClose: () => void
}) {
	const modelState = useAssistantStore(state => state.modelState)
	const historyOpen = useAssistantHistoryStore(state => state.open)

	return (
		<aside
			id={ASSISTANT_PANEL_ID}
			ref={ref}
			tabIndex={-1}
			aria-labelledby={ASSISTANT_TITLE_ID}
			className={cn(SIDE_PANEL_SURFACE_CLASS, className)}
			style={style}
			{...KEY_LAYER_PROPS}
		>
			<AssistantHeader onClose={onClose} />
			{historyOpen ? (
				<AssistantHistory />
			) : !modelAcceptsMessages(modelState) ? (
				<AssistantSetup state={modelState} />
			) : (
				<AssistantConversation />
			)}
		</aside>
	)
}

// Module scope, so React keeps one stable ref callback: while mounted the panel counts as shown for the
// runtime and as a right-docked toast obstruction, and it takes focus when the user (not a restored
// preference) opened it.
function attachInlinePanel(element: HTMLElement | null): (() => void) | undefined {
	if (element === null) {
		return undefined
	}

	const releaseToasts = toastSideObstructionRef(element)
	const releaseShown = trackAssistantPanelShown()

	if (useAssistantStore.getState().takeFocusRequest()) {
		assistantInitialFocusTarget(element)?.focus()
	}

	return () => {
		releaseToasts?.()
		releaseShown()
	}
}

function attachDrawerPanel(element: HTMLElement | null): (() => void) | undefined {
	return element === null ? undefined : trackAssistantPanelShown()
}

function closeInlinePanel(): void {
	moveFocusOutOfAssistant()
	useAssistantStore.getState().setPanelOpen(false)
}

// At most 40% of the viewport, so a wide persisted width cannot squeeze the content card away on a laptop
// screen with the module sidebar open too. A route's side panel keeps the same promise on its own side: it turns into
// its sheet once the card would drop below its minimum (shell/lib/sidePanelLayout.ts). Clamped in JS rather than by a
// CSS max-width so the resize handle's drag and key bases and its reported value match the width on screen.
function assistantPanelMaxWidth(viewportWidth: number): number {
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.floor(viewportWidth * 0.4)))
}

function subscribeToViewportWidth(listener: () => void): () => void {
	window.addEventListener("resize", listener)

	return () => {
		window.removeEventListener("resize", listener)
	}
}

// The derived cap, not the raw width, is the snapshot: it only changes between the breakpoint and about
// 1300px, so a window resize re-renders the panel only when the cap itself moves.
function viewportMaxWidthSnapshot(): number {
	return assistantPanelMaxWidth(window.innerWidth)
}

// Desktop widths: a resizable panel after the content card, mounted only while open. The drag handle sits
// on its LEFT edge (a leading-edge SidebarResizeHandle) in the row's gap, positioned against the shell's
// wrapper exactly like the left sidebars' trailing handles.
export function AssistantSidePanel() {
	const { t } = useTranslation("assistant")
	const maxWidth = useSyncExternalStore(subscribeToViewportWidth, viewportMaxWidthSnapshot)
	const resize = useResizableSidebar("assistant", maxWidth)

	return (
		<SidebarPanelVisibilityProvider visible={true}>
			<AssistantSurface
				ref={attachInlinePanel}
				className="shrink-0 app-region-pane"
				style={{ width: resize.width }}
				onClose={closeInlinePanel}
			/>
			<SidebarResizeHandle
				ariaLabel={t("assistantResize")}
				handle={resize}
			/>
		</SidebarPanelVisibilityProvider>
	)
}

function closeDrawer(): void {
	useAssistantStore.getState().setDrawerOpen(false)
}

function setDrawerOpen(open: boolean): void {
	useAssistantStore.getState().setDrawerOpen(open)
}

function drawerInitialFocus(): HTMLElement | true {
	return assistantInitialFocusTarget() ?? true
}

// Below the layout breakpoint the panel is the shared side-panel drawer (sidePanel.tsx), which the shell closes on
// every navigation and breakpoint crossing (appShell.tsx). It mounts only while open: the conversation lives in the
// store, and a hidden virtualizer would measure every row at zero. It exists only below the breakpoint, where
// widening closes the drawer in the render that drops its portal.
export function AssistantDrawer({ open, narrow }: { open: boolean; narrow: boolean }) {
	const { t } = useTranslation("assistant")

	if (!narrow) {
		return null
	}

	return (
		<SidePanelDrawer
			open={open}
			onOpenChange={setDrawerOpen}
			label={t("assistantTitle")}
			initialFocus={drawerInitialFocus}
			className="w-[26rem]"
		>
			<SidebarPanelVisibilityProvider visible={open}>
				<AssistantSurface
					ref={attachDrawerPanel}
					className="w-full flex-1"
					onClose={closeDrawer}
				/>
			</SidebarPanelVisibilityProvider>
		</SidePanelDrawer>
	)
}

// Module scope, so React keeps one stable ref callback: while the preview's slot is mounted the preview hosts the
// panel, and the shell drops its own (appShell.tsx).
function attachPreviewHost(element: HTMLElement | null): (() => void) | undefined {
	if (element === null) {
		return undefined
	}

	useAssistantStore.getState().setPreviewHosted(true)

	return () => {
		useAssistantStore.getState().setPreviewHosted(false)
	}
}

// Escape in the preview's pane closes the pane, as it closes the drawer, and the next one the preview. What took the
// key first keeps it: anything inside that cancels it, an open menu (portalled, its keys still bubble here through
// React) and a dialog over the panel. React hears it before Base UI does at the document, and the preview stands down
// for a cancelled Escape (previewOverlay.tsx handleOpenChange). Focus goes back to the preview's own layer, the
// viewer's, before the pane unmounts with it.
function closePaneOnEscape(event: KeyboardEvent<HTMLDivElement>): void {
	const target = event.target
	const host = event.currentTarget
	const layer = dialogLayerOf(host)

	if (event.key !== "Escape" || event.defaultPrevented || isImeKeydown(event.nativeEvent) || isAnyMenuOpen()) {
		return
	}

	// In the pane's DOM (a portalled menu or dialog is not), in the panel or on its resize handle.
	const targetLayer = target instanceof Element && host.contains(target) ? dialogLayerOf(target) : undefined

	if (targetLayer !== document.getElementById(ASSISTANT_PANEL_ID) && targetLayer !== layer) {
		return
	}

	event.preventDefault()

	if (layer instanceof HTMLElement) {
		layer.focus()
	}

	useAssistantStore.getState().setPanelOpen(false)
}

// The panel inside an open preview (PreviewOverlay), whose full-screen modal dialog covers the shell's: the same
// panel and conversation, moved into the dialog while it is open. At desktop widths a pane after the viewer, which only
// gets a narrower box; below the breakpoint the drawer, nested in the preview's dialog so it stacks over it with its own
// focus trap. The same open flags as in the shell, so the panel stays open or closed across the preview. It renders
// only once the slot has registered (previewHosted), so the shell's panel has unmounted by then and the two never show
// at once. Subscribes on its own, so opening or closing it never re-renders the preview.
export function PreviewAssistantPane() {
	const narrow = useIsNarrowViewport()
	const hosted = useAssistantStore(state => state.previewHosted)
	const panelOpen = useAssistantStore(state => state.panelOpen)
	const drawerOpen = useAssistantStore(state => state.drawerOpen)
	// Hidden in Settings > Assistant: no slot, so the preview never hosts a panel.
	const hidden = useAssistantHidden()

	if (hidden) {
		return null
	}

	return (
		<>
			{/* The gap before it holds the panel's leading-edge resize handle, as in the shell's row. */}
			<div
				id={ASSISTANT_PREVIEW_HOST_ID}
				ref={attachPreviewHost}
				className="relative ml-2 flex shrink-0 pr-2 pb-2 empty:hidden"
				onKeyDown={closePaneOnEscape}
			>
				{hosted && !narrow && panelOpen ? <AssistantSidePanel /> : null}
			</div>
			{hosted ? (
				<AssistantDrawer
					open={narrow && drawerOpen}
					narrow={narrow}
				/>
			) : null}
		</>
	)
}
