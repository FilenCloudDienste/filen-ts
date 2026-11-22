import type { KeyboardEvent } from "react"
import { create, type StoreApi, type UseBoundStore } from "zustand"
import { isSidePanelNarrow } from "@/features/shell/lib/sidePanelLayout"
import { toastSideObstructionRef } from "@/lib/toastClearance"

// The data attribute naming the item (a conversation, a note) a docked side panel shows (SidePanelSurface sets it).
const PANEL_KEY_ATTRIBUTE = "data-panel-key"

export interface SidePanelState {
	// The inline panel, from the side panel breakpoint up: one flag for the whole session, so it stays open from one item
	// to the next. In memory only, never persisted.
	panelOpen: boolean
	// The sheet below the breakpoint: the item it was opened for, so it never reopens over another one.
	drawerKey: string | null
	// The item whose inline panel should take focus when it mounts: set when the user opens a panel not yet on screen,
	// and cleared by the next panel to mount whichever item it is for, so it can never fire later.
	focusRequestedFor: string | null
}

// One docked side panel's open state and the DOM plumbing around it: the inline panel beside the content card from the
// breakpoint up, the sheet below it. Every function is created once per panel, so React sees stable callbacks.
export interface SidePanelController {
	panelId: string
	titleId: string
	useStore: UseBoundStore<StoreApi<SidePanelState>>
	// Opens the panel (or, below the breakpoint, the sheet) for an item. The caller opens the item itself.
	open: (key: string) => void
	// Closes it when it shows for this item, opens it otherwise.
	toggle: (key: string) => void
	closePanel: () => void
	closeDrawer: () => void
	// Whether the panel now mounting for this item should take focus; consumes any request either way.
	takeFocusRequest: (key: string | undefined) => boolean
	// Whether the panel for this item is showing at the current width.
	useOpen: (key: string, narrow: boolean) => boolean
	// Closes the inline panel, moving focus out of it first (see createSidePanelController).
	closeInlinePanel: () => void
	// Ref callback for the inline panel: focus on a user's open, and a right-docked toast obstruction while mounted.
	attachInlinePanel: (element: HTMLElement | null) => (() => void) | undefined
	// Escape from the inline panel's own DOM closes it.
	handleInlineKeyDown: (event: KeyboardEvent<HTMLElement>) => void
	drawerInitialFocus: () => HTMLElement | true
	setDrawerOpen: (open: boolean) => void
}

// `returnFocusId`: the header toggle focus goes back to when the inline panel closes with focus inside it.
export function createSidePanelController({ panelId, returnFocusId }: { panelId: string; returnFocusId: string }): SidePanelController {
	const useStore = create<SidePanelState>(() => ({ panelOpen: false, drawerKey: null, focusRequestedFor: null }))

	function shownPanel(key: string): HTMLElement | null {
		const panel = document.getElementById(panelId)

		return panel?.getAttribute(PANEL_KEY_ATTRIBUTE) === key ? panel : null
	}

	function open(key: string): void {
		if (isSidePanelNarrow()) {
			useStore.setState({ drawerKey: key })

			return
		}

		// Already showing for this item: nothing will mount, so focus moves now.
		const panel = shownPanel(key)

		if (useStore.getState().panelOpen && panel !== null) {
			panel.focus()

			return
		}

		useStore.setState({ panelOpen: true, focusRequestedFor: key })
	}

	function closePanel(): void {
		useStore.setState({ panelOpen: false, focusRequestedFor: null })
	}

	function closeDrawer(): void {
		if (useStore.getState().drawerKey !== null) {
			useStore.setState({ drawerKey: null })
		}
	}

	// Closing unmounts the inline panel; focus inside it would fall back to the document body, so it moves out first.
	// Focus elsewhere stays where the user put it.
	function closeInlinePanel(): void {
		if (document.getElementById(panelId)?.contains(document.activeElement) === true) {
			document.getElementById(returnFocusId)?.focus()
		}

		closePanel()
	}

	function toggle(key: string): void {
		if (isSidePanelNarrow()) {
			if (useStore.getState().drawerKey === key) {
				closeDrawer()
			} else {
				open(key)
			}

			return
		}

		if (useStore.getState().panelOpen && shownPanel(key) !== null) {
			closeInlinePanel()
		} else {
			open(key)
		}
	}

	function takeFocusRequest(key: string | undefined): boolean {
		const requested = useStore.getState().focusRequestedFor

		if (requested === null) {
			return false
		}

		useStore.setState({ focusRequestedFor: null })

		return requested === key
	}

	function useOpen(key: string, narrow: boolean): boolean {
		return useStore(state => (narrow ? state.drawerKey === key : state.panelOpen))
	}

	function attachInlinePanel(element: HTMLElement | null): (() => void) | undefined {
		if (element === null) {
			return undefined
		}

		if (takeFocusRequest(element.getAttribute(PANEL_KEY_ATTRIBUTE) ?? undefined)) {
			element.focus()
		}

		return toastSideObstructionRef(element)
	}

	// Only for keys from the panel's own DOM: a row menu or a confirm is portalled out of it and closes itself first.
	function handleInlineKeyDown(event: KeyboardEvent<HTMLElement>): void {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!(event.target instanceof Node) ||
			!event.currentTarget.contains(event.target)
		) {
			return
		}

		event.preventDefault()
		// Never also a document-level Escape action (a sidebar's clear-selection).
		event.stopPropagation()
		closeInlinePanel()
	}

	// The sheet itself (focusable via tabIndex -1), like the inline panel: its first control is the close button, whose
	// tooltip would otherwise open over the panel on every open.
	function drawerInitialFocus(): HTMLElement | true {
		return document.getElementById(panelId) ?? true
	}

	function setDrawerOpen(next: boolean): void {
		if (!next) {
			closeDrawer()
		}
	}

	return {
		panelId,
		titleId: `${panelId}-title`,
		useStore,
		open,
		toggle,
		closePanel,
		closeDrawer,
		takeFocusRequest,
		useOpen,
		closeInlinePanel,
		attachInlinePanel,
		handleInlineKeyDown,
		drawerInitialFocus,
		setDrawerOpen
	}
}
