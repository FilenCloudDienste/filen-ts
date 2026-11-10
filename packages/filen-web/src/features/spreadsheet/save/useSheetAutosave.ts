import { useEffect, useRef, useState } from "react"
import { E2E_AUTOSAVE_OFF } from "@/features/office/lib/officeAutosave"
import { loadOfficeSettings, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { useIsOnline } from "@/lib/useIsOnline"
import { useLatestRef } from "@/lib/useLatestRef"

export interface SheetAutosaveInput {
	// The session's version (SheetDocState.version): it moves with every edit, undo and redo.
	version: number
	// Edits not yet saved (an open entry does not count: it is not an edit until committed).
	dirty: boolean
	// A cell entry is open: never committed for the user by a save they did not ask for.
	editing: boolean
	// This file may be saved here now.
	canSave: boolean
	// Asks the overlay to save through its own save path; true when a save started.
	onAutosave: (() => boolean) | undefined
}

// Idle autosave, as the Word document editor's: a pause of the user's autosave delay after the last edit saves once,
// while the user's setting (Settings, Office) says so, once that setting was read (never on the default before). A
// version a save started for is not tried again (a failed save waits for the next edit); one whose save could not
// start (a save in flight, a dialog open) is tried after the next pause. Offline, or with a cell entry open, it
// waits.
export function useSheetAutosave({ version, dirty, editing, canSave, onAutosave }: SheetAutosaveInput): void {
	const settings = useOfficeSettings()
	const online = useIsOnline()
	const onAutosaveRef = useLatestRef(onAutosave)
	const savedVersion = useRef<number | null>(null)
	const [retry, setRetry] = useState(0)
	const wanted = onAutosave !== undefined

	useEffect(() => {
		if (wanted) {
			void loadOfficeSettings()
		}
	}, [wanted])

	useEffect(() => {
		if (
			!wanted ||
			!settings.loaded ||
			!settings.autosave ||
			E2E_AUTOSAVE_OFF ||
			!dirty ||
			editing ||
			!canSave ||
			!online ||
			savedVersion.current === version
		) {
			return undefined
		}

		const timer = setTimeout(() => {
			if (onAutosaveRef.current?.() === true) {
				savedVersion.current = version
			} else {
				setRetry(count => count + 1)
			}
		}, settings.autosaveDelayMs)

		return () => {
			clearTimeout(timer)
		}
	}, [
		wanted,
		settings.loaded,
		settings.autosave,
		settings.autosaveDelayMs,
		dirty,
		editing,
		canSave,
		online,
		version,
		retry,
		onAutosaveRef
	])
}
