import { createSidePanelController } from "@/features/shell/lib/sidePanelStore"

// Mounted at most once (inline beside the note, or in the sheet), so the fixed id is unique.
export const NOTE_PARTICIPANTS_PANEL_ID = "note-participants-panel"

// The note participants panel's open state, the chat info panel's model: open from one note to the next while the
// session lasts (inline), or for the one note it was opened for (sheet). It has no header toggle, so closing it from
// inside returns focus to wherever it was before the panel took it.
export const noteParticipantsPanel = createSidePanelController({ panelId: NOTE_PARTICIPANTS_PANEL_ID })
