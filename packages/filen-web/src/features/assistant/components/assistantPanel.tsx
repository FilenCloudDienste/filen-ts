import { useSyncExternalStore, type CSSProperties, type Ref } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { SIDE_PANEL_SURFACE_CLASS, SidePanelDrawer } from "@/components/sidePanel"
import { toastSideObstructionRef } from "@/lib/toastClearance"
import { useResizableSidebar } from "@/features/shell/hooks/useResizableSidebar"
import { SidebarResizeHandle } from "@/features/shell/components/sidebarResizeHandle"
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@/features/shell/lib/sidebarWidth"
import { SidebarPanelVisibilityProvider } from "@/features/shell/lib/sidebarPanelVisibility"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { modelAcceptsMessages, trackAssistantPanelShown } from "@/features/assistant/store/assistantSession"
import { AssistantHeader } from "@/features/assistant/components/assistantHeader"
import { AssistantSetup } from "@/features/assistant/components/assistantSetup"
import { AssistantConversation } from "@/features/assistant/components/assistantConversation"
import { AssistantHistory } from "@/features/assistant/components/assistantHistory"
import { useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import {
	ASSISTANT_PANEL_ID,
	ASSISTANT_TITLE_ID,
	assistantInitialFocusTarget,
	moveFocusOutOfAssistant
} from "@/features/assistant/components/assistantFocus"

// The shared side-panel surface (sidePanel.tsx). tabIndex -1 makes the panel itself the focus fallback when it holds
// no focusable control yet.

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
// screen with the module sidebar open too. Clamped in JS rather than by a CSS max-width so the resize
// handle's drag and key bases and its reported value match the width on screen.
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
