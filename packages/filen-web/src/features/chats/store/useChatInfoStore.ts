import { createSidePanelController } from "@/features/shell/lib/sidePanelStore"

// Mounted at most once (inline beside the thread, or in the sheet), so fixed ids are unique.
export const CHAT_INFO_PANEL_ID = "chat-info-panel"
export const CHAT_INFO_TOGGLE_ID = "chat-info-toggle"

// The chat info panel's open state: open from one conversation to the next while the session lasts (inline), or
// for the one conversation it was opened for (sheet). Closing the inline panel from inside it returns focus to the
// thread header's toggle.
export const chatInfoPanel = createSidePanelController({ panelId: CHAT_INFO_PANEL_ID, returnFocusId: CHAT_INFO_TOGGLE_ID })

export const useChatInfoStore = chatInfoPanel.useStore
export const openChatInfo = chatInfoPanel.open
export const closeChatInfoPanel = chatInfoPanel.closePanel
export const closeChatInfoDrawer = chatInfoPanel.closeDrawer
export const useChatInfoOpen = chatInfoPanel.useOpen
