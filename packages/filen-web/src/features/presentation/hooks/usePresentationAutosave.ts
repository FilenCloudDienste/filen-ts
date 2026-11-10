import { useEffect, useRef, useState } from "react"
import { E2E_AUTOSAVE_OFF } from "@/features/office/lib/officeAutosave"
import { loadOfficeSettings, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { autosaveDueIn, type AutosaveTier } from "@/features/presentation/lib/autosavePolicy"
import { useIsOnline } from "@/lib/useIsOnline"
import { useLatestRef } from "@/lib/useLatestRef"

// When a deck autosaves (lib/autosavePolicy.ts decides from the package's size): the editor reports its history's
// revision and dirtiness and how its saves ended; this hook keeps the times the policy reads and asks the overlay to
// save when one is due, while the user's autosave setting (Settings, Office) is on, once that setting was read.
// Offline it waits. A save that could not start now (one in flight, a dialog open) is tried again a moment later.

// A save that could not start is asked for again after this long.
export const AUTOSAVE_BUSY_RETRY_MS = 5_000

export interface PresentationSaveOutcome {
	// The save stored a version of the file.
	readonly stored: boolean
	// It ended without a file (an upload that failed, a refusal); a deck with nothing to save is neither.
	readonly failed: boolean
}

export interface PresentationAutosaveInput {
	readonly tier: AutosaveTier
	// The history's revision: it moves with every command, undo and redo.
	readonly revision: number
	readonly dirty: boolean
	readonly dirtyBytes: number | undefined
	// The deck may be saved here now.
	readonly canSave: boolean
	// Asks the overlay to save through its own path; true when a save started. Undefined: nothing autosaves.
	readonly onAutosave: (() => boolean) | undefined
}

export interface PresentationAutosave {
	// The user's setting allows autosave and the tier does: an idle deck saves itself.
	readonly active: boolean
	// Reports how a save (the user's or this hook's) ended.
	readonly settled: (outcome: PresentationSaveOutcome) => void
}

interface Times {
	// The last edit, and the oldest edit not stored yet.
	lastEditAt: number
	firstUnsavedAt: number
	lastStoredAt: number | undefined
	failures: number
	lastFailedAt: number | undefined
	revision: number
	dirty: boolean
}

export function usePresentationAutosave({
	tier,
	revision,
	dirty,
	dirtyBytes,
	canSave,
	onAutosave
}: PresentationAutosaveInput): PresentationAutosave {
	const settings = useOfficeSettings()
	const online = useIsOnline()
	const onAutosaveRef = useLatestRef(onAutosave)
	const times = useRef<Times>({
		lastEditAt: 0,
		firstUnsavedAt: 0,
		lastStoredAt: undefined,
		failures: 0,
		lastFailedAt: undefined,
		revision,
		dirty
	})
	// Bumped to look again after a save ended or could not start.
	const [check, setCheck] = useState(0)
	const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const wanted = onAutosave !== undefined
	const active = wanted && tier.kind !== "off" && settings.loaded && settings.autosave && !E2E_AUTOSAVE_OFF

	useEffect(() => {
		if (wanted) {
			void loadOfficeSettings()
		}
	}, [wanted])

	useEffect(
		() => () => {
			clearTimeout(retry.current)
		},
		[]
	)

	// The edit times, as the history moves.
	useEffect(() => {
		const now = Date.now()
		const held = times.current

		if (revision !== held.revision && dirty) {
			held.lastEditAt = now
		}

		if (dirty && !held.dirty) {
			held.firstUnsavedAt = now
		}

		held.revision = revision
		held.dirty = dirty
	}, [revision, dirty])

	useEffect(() => {
		if (!active || !dirty || !canSave || !online) {
			return undefined
		}

		const held = times.current
		const due = autosaveDueIn(tier, {
			now: Date.now(),
			dirty,
			lastEditAt: held.lastEditAt,
			firstUnsavedAt: held.firstUnsavedAt,
			lastStoredAt: held.lastStoredAt,
			dirtyBytes,
			failures: held.failures,
			...(held.lastFailedAt === undefined ? {} : { lastFailedAt: held.lastFailedAt })
		})

		if (due === undefined) {
			return undefined
		}

		const timer = setTimeout(() => {
			if (onAutosaveRef.current?.() !== true) {
				// Not now (a save in flight, a dialog open): a little later.
				clearTimeout(retry.current)
				retry.current = setTimeout(() => {
					retry.current = undefined
					setCheck(count => count + 1)
				}, AUTOSAVE_BUSY_RETRY_MS)
			}
		}, due)

		return () => {
			clearTimeout(timer)
		}
	}, [active, tier, dirty, dirtyBytes, canSave, online, revision, check, onAutosaveRef])

	return {
		active,
		settled: outcome => {
			const now = Date.now()
			const held = times.current

			if (outcome.stored) {
				held.lastStoredAt = now
				held.failures = 0
				held.lastFailedAt = undefined
				// Edits made while it saved are the oldest unsaved ones from here.
				held.firstUnsavedAt = now
			} else if (outcome.failed || held.dirty) {
				// A save that stored nothing while the deck still reads dirty backs off as a failure does: asking again
				// at once would only get the same answer.
				held.failures++
				held.lastFailedAt = now
			}

			setCheck(count => count + 1)
		}
	}
}
