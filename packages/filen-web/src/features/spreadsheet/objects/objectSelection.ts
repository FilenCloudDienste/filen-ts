import { useSyncExternalStore } from "react"
import type { SheetId } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import type { SheetDrawingObject } from "@filen/office/react/sheet/drawings"
import { createModelStore } from "@/features/spreadsheet/lib/modelStore"

// The drawing object selected in a grid (instead of cells), shared by the objects overlay and what acts on it (the
// grid's menu, a chart's side panel). Named by sheet and z-order key; the object itself is read from the sheet's
// layout as it now is.

export interface ObjectSelection {
	readonly sheet: SheetId
	readonly key: number
}

// The same object named again changes nothing.
const store = createModelStore<ObjectSelection | null>(null, (a, b) => a?.sheet === b?.sheet && a?.key === b?.key)

export function selectObject(model: SheetGridModel, selection: ObjectSelection | null): void {
	store.set(model, selection)
}

export function selectedObjectKey(model: SheetGridModel): ObjectSelection | null {
	return store.get(model)
}

export function useObjectSelection(model: SheetGridModel): ObjectSelection | null {
	return store.useValue(model)
}

// The selected object as the sheet on show now lists it; null when none is selected (cells are) or it is gone.
export function useSelectedObject(model: SheetGridModel): { readonly sheet: SheetId; readonly object: SheetDrawingObject } | null {
	const selection = useObjectSelection(model)
	const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)

	if (selection?.sheet !== snapshot.sheet) {
		return null
	}

	const object = snapshot.layout?.extensions?.drawings?.objects.find(candidate => candidate.key === selection.key)

	return object === undefined ? null : { sheet: selection.sheet, object }
}
