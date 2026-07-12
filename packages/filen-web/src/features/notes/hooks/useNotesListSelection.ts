import { useEffect, useState, type MouseEvent } from "react"
import type { Note } from "@filen/sdk-rs"
import { clampListboxIndex, listboxRange, resolveCursorIndex } from "@/features/drive/lib/listbox"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"

export interface UseNotesListSelectionParams {
	// The ordered, currently-rendered selectable set — every note row across whichever sidebar
	// view is active (notesSidebar.tsx's flattened `rows`, note-kind entries only), in render order.
	// Shift-range math walks this array's indices.
	notes: readonly Note[]
	// A fresh view must never inherit the previous one's selection/anchor — keyed on the sidebar's
	// view mode (mirrors drive's [variant, splat] reset in useDriveListboxNav), so switching between
	// the notes and tags views clears any active selection (mobile parity, notesHeaderMenuBuilders.ts's
	// own view-mode-switch clear).
	resetKey: string
}

export interface NotesListSelection {
	// Drive's modifier-click model, ported: plain click replaces the selection with just this note
	// (the row's own onClick still lets the Link navigate — see noteRow.tsx); Ctrl/Cmd+click toggles
	// it into a multi-selection; Shift+click extends a range from the last non-shift anchor.
	handlePointerSelect: (index: number, event: MouseEvent) => void
}

// The notes-list counterpart to useDriveListboxNav, sized down to what a Link-based row list needs:
// no roving-tabindex keyboard cursor (notes rows are real anchors, not a virtualizer-backed ARIA
// listbox), just the anchor-tracked range/toggle math pointer clicks need. Reuses drive's own pure
// range helpers (listbox.ts) rather than re-deriving them.
export function useNotesListSelection({ notes, resetKey }: UseNotesListSelectionParams): NotesListSelection {
	// Tracked by uuid, not position — a positional index alone drifts under a background reorder
	// (pin/favorite toggling a note into a different sort bucket, a live socket patch) with no click
	// involved, silently retargeting the next Shift+click's range onto the wrong item. `fallbackIndex`
	// is the last position the tracked uuid resolved to, used only once that uuid is no longer present
	// (mirrors useDriveListboxNav's identical activeFallback/anchorFallback rationale).
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)
	const [anchorFallback, setAnchorFallback] = useState(0)

	const uuids = notes.map(note => note.uuid)
	const safeAnchorIndex = clampListboxIndex(resolveCursorIndex(anchorUuid, uuids, anchorFallback), notes.length)

	if (anchorFallback !== safeAnchorIndex) {
		setAnchorFallback(safeAnchorIndex)
	}

	useEffect(() => {
		useNotesSelectionStore.getState().clearSelectedNotes()
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate view-switch reset, mirrors useDriveListboxNav
		setAnchorUuid(null)
		setAnchorFallback(0)
	}, [resetKey])

	function selectRange(anchor: number, active: number): void {
		const rangeNotes: Note[] = []

		for (const i of listboxRange(anchor, active)) {
			const note = notes[i]

			if (note) {
				rangeNotes.push(note)
			}
		}

		useNotesSelectionStore.getState().setSelectedNotes(rangeNotes)
	}

	function handlePointerSelect(index: number, event: MouseEvent): void {
		const note = notes[index]

		if (!note) {
			return
		}

		if (event.shiftKey) {
			// The anchor deliberately does NOT move here — a run of consecutive Shift+clicks must keep
			// ranging from the same fixed starting point (the last plain/Ctrl+click), exactly like
			// useDriveListboxNav's own handlePointerSelect (which moves the roving CURSOR on a shift-click
			// but never the separate range anchor). Moving it here would make a second Shift+click range
			// from the first Shift+click's target instead of the original anchor.
			selectRange(safeAnchorIndex, index)

			return
		}

		if (event.metaKey || event.ctrlKey) {
			useNotesSelectionStore.getState().toggleSelectedNote(note)
			setAnchorUuid(note.uuid)

			return
		}

		useNotesSelectionStore.getState().setSelectedNotes([note])
		setAnchorUuid(note.uuid)
	}

	return { handlePointerSelect }
}
