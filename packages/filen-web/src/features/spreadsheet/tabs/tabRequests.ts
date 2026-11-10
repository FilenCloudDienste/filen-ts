import { useEffect } from "react"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { useLatestRef } from "@/lib/useLatestRef"

// What the ribbon and the keyboard ask of the sheet tabs for the sheet on show (Cells ▸ Format ▸ Rename sheet, Delete ▸
// Delete sheet, Review ▸ Protect, and the tab menu's Duplicate, Move, Hide and Unhide): the tabs own those dialogs, the
// protection prompts and the menu's own gating.

export type SheetTabRequest =
	"rename" | "delete" | "duplicate" | "moveLeft" | "moveRight" | "hide" | "unhide" | "protectSheet" | "protectWorkbook"

const listeners = new WeakMap<SheetGridModel, Set<(request: SheetTabRequest) => void>>()

export function requestSheetTab(model: SheetGridModel, request: SheetTabRequest): void {
	for (const listener of listeners.get(model) ?? []) {
		listener(request)
	}
}

export function useSheetTabRequests(model: SheetGridModel, take: (request: SheetTabRequest) => void): void {
	const latest = useLatestRef(take)

	useEffect(() => {
		let set = listeners.get(model)

		if (set === undefined) {
			set = new Set()
			listeners.set(model, set)
		}

		const listener = (request: SheetTabRequest): void => {
			latest.current(request)
		}

		set.add(listener)

		return () => {
			set.delete(listener)
		}
	}, [model, latest])
}
