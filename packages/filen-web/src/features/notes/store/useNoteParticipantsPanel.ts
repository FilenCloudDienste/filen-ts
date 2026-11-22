import { createSidePanelController } from "@/features/shell/lib/sidePanelStore"

// Mounted at most once (inline beside the note, or in the sheet), so the fixed ids are unique.
export const NOTE_PARTICIPANTS_PANEL_ID = "note-participants-panel"
export const NOTE_PARTICIPANTS_TOGGLE_ID = "note-participants-toggle"

// The note participants panel's open state, the chat info panel's model: open from one note to the next while the
// session lasts (inline), or for the one note it was opened for (sheet). Closing the inline panel from inside it returns
// focus to the note header's toggle.
export const noteParticipantsPanel = createSidePanelController({
	panelId: NOTE_PARTICIPANTS_PANEL_ID,
	returnFocusId: NOTE_PARTICIPANTS_TOGGLE_ID
})
