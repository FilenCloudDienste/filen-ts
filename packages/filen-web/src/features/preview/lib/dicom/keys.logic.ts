import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { DICOM_VIEWER_ACTIONS, type DicomViewerAction } from "@/features/preview/lib/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// The DICOM viewer's action a keydown is under `combos` (the combos in effect by id, useBindings).
export function dicomViewerKey(
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): DicomViewerAction | undefined {
	return DICOM_VIEWER_ACTIONS.find(def => matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac))?.id
}

// The frame a step lands on: the ends hold (no wrap), as a page key's do.
export function stepFrame(frame: number, frames: number, action: DicomViewerAction): number {
	return Math.min(frames - 1, Math.max(0, frame + (action === "preview.dicomNextFrame" ? 1 : -1)))
}
