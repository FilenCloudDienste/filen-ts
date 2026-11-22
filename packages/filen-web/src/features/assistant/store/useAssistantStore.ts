import { type } from "arktype"
import { create } from "zustand"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"
import {
	applyAssistantEvent,
	beginTurn,
	setProposalStatus,
	setStepsExpanded,
	INITIAL_TRANSCRIPT_STATE,
	type ProposalStatus,
	type TranscriptEntry,
	type TranscriptState
} from "@/features/assistant/store/transcript"
import type { AssistantEvent, AssistantModelState } from "@/features/assistant/types"

// The assistant panel's UI state. The transcript holds decrypted names and note or chat excerpts, so it
// reaches storage only as a saved conversation on this device (conversationHistory.ts: kv, which logout
// wipes, so it is per account without a prefix), never with raw tool output. Whether the panel is open
// persists the same way.
const PANEL_OPEN_KV_KEY = "assistant.v1.panelOpen"

interface AssistantStore extends TranscriptState {
	// The inline panel at desktop widths. Persisted.
	panelOpen: boolean
	// The drawer below the layout breakpoint. Never persisted: the shell closes it on every navigation.
	drawerOpen: boolean
	// A preview is open and shows the panel (inline or as the drawer, by the two flags above) in its modal
	// dialog, which covers the shell: the shell mounts neither while it is set, so the conversation shows once.
	previewHosted: boolean
	draft: string
	// The open document (activeDocumentKey) the user detached from the next question with the chip's ×; cleared when
	// a message is sent. Another document opening shows its chip again, the key no longer matching.
	detachedDocument: string | null
	setDetachedDocument: (key: string | null) => void
	// Set by a user-initiated open of the inline panel; its first focus target takes focus once and clears
	// it. A panel restored open at boot never steals focus. The drawer has Base UI's own initial focus.
	focusRequested: boolean
	setPanelOpen: (open: boolean) => void
	setDrawerOpen: (open: boolean) => void
	setPreviewHosted: (hosted: boolean) => void
	setDraft: (draft: string) => void
	takeFocusRequest: () => boolean
	applyEvent: (event: AssistantEvent) => void
	// Several events as one update: one render for a frame's worth of streamed text and progress.
	applyEvents: (events: readonly AssistantEvent[]) => void
	beginTurn: (turnId: string, text: string) => void
	setProposalStatus: (proposalId: string, status: ProposalStatus) => void
	setStepsExpanded: (turnId: string, expanded: boolean) => void
	// A different session took over: its model state, and an empty conversation (the old one's context is gone).
	resetConversation: (modelState: AssistantModelState) => void
	// A saved conversation replaces the current one, settled: no turn runs in it.
	loadConversation: (entries: readonly TranscriptEntry[]) => void
}

export const useAssistantStore = create<AssistantStore>((set, get) => ({
	...INITIAL_TRANSCRIPT_STATE,
	panelOpen: false,
	drawerOpen: false,
	previewHosted: false,
	draft: "",
	detachedDocument: null,
	focusRequested: false,
	setDetachedDocument: key => {
		set({ detachedDocument: key })
	},
	setPanelOpen: open => {
		panelOpenUserModified = true
		set({ panelOpen: open, focusRequested: open })
		void kvSetJsonQuiet(PANEL_OPEN_KV_KEY, open, "assistant", "panel open state")
	},
	setDrawerOpen: open => {
		set({ drawerOpen: open })
	},
	setPreviewHosted: hosted => {
		set({ previewHosted: hosted })
	},
	setDraft: draft => {
		set({ draft })
	},
	takeFocusRequest: () => {
		if (!get().focusRequested) {
			return false
		}

		set({ focusRequested: false })

		return true
	},
	applyEvent: event => {
		set(state => applyAssistantEvent(state, event))
	},
	applyEvents: events => {
		if (events.length > 0) {
			set(state => events.reduce(applyAssistantEvent, state))
		}
	},
	beginTurn: (turnId, text) => {
		set(state => beginTurn(state, turnId, text))
	},
	setProposalStatus: (proposalId, status) => {
		set(state => ({ entries: setProposalStatus(state.entries, proposalId, status) }))
	},
	setStepsExpanded: (turnId, expanded) => {
		set(state => ({ entries: setStepsExpanded(state.entries, turnId, expanded) }))
	},
	resetConversation: modelState => {
		set({ ...INITIAL_TRANSCRIPT_STATE, modelState })
	},
	loadConversation: entries => {
		set({ entries, activeTurnId: null, settled: null })
	}
}))

// A toggle that lands before the persisted value loads must win over it.
let panelOpenUserModified = false

export const hydrateAssistantPanelOpen = kvLoadOnce(
	PANEL_OPEN_KV_KEY,
	type("boolean"),
	open => {
		if (!panelOpenUserModified) {
			useAssistantStore.setState({ panelOpen: open })
		}
	},
	"assistant",
	"panel open state"
)

export function toggleAssistant(narrow: boolean): void {
	const { panelOpen, drawerOpen, setPanelOpen, setDrawerOpen } = useAssistantStore.getState()

	if (narrow) {
		setDrawerOpen(!drawerOpen)

		return
	}

	setPanelOpen(!panelOpen)
}

// Whether the panel is showing at the current width; what the rail toggle reports as pressed.
export function useAssistantVisible(narrow: boolean): boolean {
	return useAssistantStore(state => (narrow ? state.drawerOpen : state.panelOpen))
}

export default useAssistantStore
