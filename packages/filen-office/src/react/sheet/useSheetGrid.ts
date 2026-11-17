import { useSyncExternalStore } from "react"
import type { SheetOpened } from "../../core/sheet/protocol"
import { SheetGridModel, type SheetGridSnapshot } from "./model"

// A grid over an open session. The app creates the model as soon as the session opens (so it can hand the host's
// events to model.handleEvent from the start), renders <SheetGrid grid={model} />, and reads what its own controls
// need (sheet tabs, the formula bar, undo state) through useSheetGrid.

export function createSheetGrid(opened: SheetOpened): SheetGridModel {
	return new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })
}

export interface SheetGridState extends SheetGridSnapshot {
	readonly model: SheetGridModel
}

export function useSheetGrid(model: SheetGridModel): SheetGridState {
	const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)

	return { ...snapshot, model }
}
