import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"

export interface SeparatorValueOptions {
	persisted: number
	// null = no usable value for this pointer position; the drag leaves the current value alone.
	fromPointer: (startValue: number, startClientX: number, clientX: number) => number | null
	fromKey: (key: string, value: number) => number | null
	commit: (value: number) => Promise<unknown>
	refetch: () => unknown
}

export interface SeparatorValue {
	value: number
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
	onPointerCancel: () => void
	onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
	onKeyUp: () => void
	onBlur: () => void
}

// The drag + keyboard state machine behind a persisted role="separator": a live override while
// adjusting, committed once per release rather than per event.
export function useSeparatorValue({ persisted, fromPointer, fromKey, commit, refetch }: SeparatorValueOptions): SeparatorValue {
	// Local override backing both the drag and the keyboard adjustment — the persisted query value only
	// ever refreshes after a commit, so neither round-trips through the kv write per pointermove/keydown.
	const [pendingValue, setPendingValue] = useState<number | null>(null)
	const value = pendingValue ?? persisted
	// Doubles as the "currently dragging" flag (non-null while a drag is in progress) and the drag's
	// start values.
	const startRef = useRef<{ value: number; clientX: number } | null>(null)
	// "There is an uncommitted adjustment". pendingValue cannot serve as this test: it is never cleared,
	// so it stays non-null forever after the first adjustment and every later blur would rewrite it.
	const pendingCommitRef = useRef(false)

	// Deliberately does NOT clear pendingValue. The persisted value comes from a plain query with no
	// optimistic write, so dropping the local override here would snap back to the stale persisted
	// value until the refetch lands, and the next arrow key would compute its step off that stale base.
	// The refetch converges the two onto the same number.
	function commitPending(): void {
		if (!pendingCommitRef.current || pendingValue === null) {
			return
		}

		pendingCommitRef.current = false

		void commit(pendingValue).then(() => refetch())
	}

	function onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
		event.preventDefault()
		// Seeded from the EFFECTIVE value, not the persisted one: a drag started after a keyboard
		// adjustment would otherwise rewind to the last persisted value on the first pointermove.
		startRef.current = { value, clientX: event.clientX }
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	function onPointerMove(event: ReactPointerEvent<HTMLElement>): void {
		const start = startRef.current

		if (start === null) {
			return
		}

		const next = fromPointer(start.value, start.clientX, event.clientX)

		if (next === null) {
			return
		}

		setPendingValue(next)
		pendingCommitRef.current = true
	}

	function onPointerUp(event: ReactPointerEvent<HTMLElement>): void {
		if (startRef.current === null) {
			return
		}

		startRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)

		commitPending()
	}

	// A cancelled drag (the browser reclaiming a touch gesture, pen palm-rejection) never fires pointerup,
	// so without this the drag flag would stay set and silently veto every later keyboard commit below.
	// The separator already shows the last dragged position, so that position is what gets committed.
	function onPointerCancel(): void {
		if (startRef.current === null) {
			return
		}

		startRef.current = null

		commitPending()
	}

	function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
		const next = fromKey(event.key, value)

		if (next === null) {
			return
		}

		// Arrows/Home/End would otherwise scroll whatever sits behind the focused separator.
		event.preventDefault()
		setPendingValue(next)
		pendingCommitRef.current = true
	}

	// Commit on release, not on keydown: OS autorepeat fires keydown ~30x/s and each commit is a kv
	// write plus a refetch, so a held key collapses into one write exactly like the pointer path. Also
	// wired to blur, so focus leaving mid-press never loses an adjustment; a live drag owns its own
	// commit.
	function handleRelease(): void {
		if (startRef.current !== null) {
			return
		}

		commitPending()
	}

	return { value, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown, onKeyUp: handleRelease, onBlur: handleRelease }
}
