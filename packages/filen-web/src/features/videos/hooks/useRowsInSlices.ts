import { useEffect, useState } from "react"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"

// Rows mounted on the first render, then per idle slice: a long list shows its first screen at once and the rest
// follows in order, so tab order and find-in-page see every row once the slices are done.
export const FIRST_SLICE_ROWS = 40
export const SLICE_ROWS = 80

// How many of `total` rows to mount now.
export function useRowsInSlices(total: number): number {
	const [count, setCount] = useState(() => Math.min(total, FIRST_SLICE_ROWS))

	useEffect(() => {
		if (count >= total) {
			return
		}

		return scheduleIdle(
			() => {
				setCount(Math.min(total, count + SLICE_ROWS))
			},
			{ timeout: 200, fallbackMs: 16 }
		)
	}, [count, total])

	return Math.min(count, total)
}
