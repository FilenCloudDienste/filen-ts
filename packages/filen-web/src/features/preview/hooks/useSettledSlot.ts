import { useLayoutEffect, useRef, useState } from "react"

// Within this long of the previous step, a step counts as part of a run (a held arrow key).
const STEP_SETTLE_MS = 150

// Whether the slot keyed `slotKey` may mount its viewer yet. A run of steps passes through slots faster
// than any of them could load, and mounting each would start and then cancel its download, stream or
// decode; so a slot reached mid-run mounts only once it has stayed current for STEP_SETTLE_MS. An
// isolated step mounts before paint, with no delay.
export function useSettledSlot(slotKey: string | null): boolean {
	const [settled, setSettled] = useState(slotKey)
	const lastStepAt = useRef(Number.NEGATIVE_INFINITY)

	useLayoutEffect(() => {
		if (settled === slotKey) {
			return
		}

		const now = performance.now()
		const inRun = now - lastStepAt.current < STEP_SETTLE_MS

		lastStepAt.current = now

		if (!inRun) {
			setSettled(slotKey)

			return
		}

		const timer = setTimeout(() => {
			setSettled(slotKey)
		}, STEP_SETTLE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [slotKey, settled])

	return settled === slotKey
}
