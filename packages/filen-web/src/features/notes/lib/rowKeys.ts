import type { Options } from "react-hotkeys-hook"
import { ignoredUnderOverlays } from "@/lib/keymap/useAction"

// The uuid of the note whose sidebar row a key was pressed in (noteRow.tsx's data-note-uuid), or undefined outside one.
export function rowNoteUuid(target: EventTarget | null): string | undefined {
	return target instanceof Element ? target.closest<HTMLElement>("[data-note-uuid]")?.dataset["noteUuid"] : undefined
}

// Whether a notes action for the focused row only (its single keys) stands down: anywhere but a note's row, or under
// any dialog or menu. It runs before useAction's preventDefault, so the key keeps its default there.
export function ignoredOffNoteRow(event: KeyboardEvent): boolean {
	return ignoredUnderOverlays(event) || rowNoteUuid(event.target) === undefined
}

export const ON_FOCUSED_ROW: Options = { ignoreEventWhen: ignoredOffNoteRow }
