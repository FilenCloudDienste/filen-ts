import { useLayoutEffect, useRef, type RefObject } from "react"
import { prefersReducedMotion } from "@/lib/motion"
import type { TransferGroup } from "@/features/transfers/lib/order"

// A row's marks for useGroupMoves: its id and its group (lib/order.ts).
export const ORDER_ID_ATTRIBUTE = "data-order-id"
export const ORDER_GROUP_ATTRIBUTE = "data-order-group"

export function orderAttributes(id: string, group: TransferGroup): Record<string, string> {
	return { [ORDER_ID_ATTRIBUTE]: id, [ORDER_GROUP_ATTRIBUTE]: String(group) }
}

interface Placed {
	group: string
	x: number
	y: number
}

const MOVE_DURATION_MS = 200

// Slides a row that changed group from where it stood into its new place (FLIP, on the Web Animations API), and no
// other row. Only the rows on screen are read, after each commit of the list: their offsets within `container`, which
// must be their offsetParent so that scrolling it moves nothing. A row that was not on screen before just appears.
// Nothing moves under prefers-reduced-motion.
export function useGroupMoves(container: RefObject<HTMLElement | null>): void {
	const placedRef = useRef<Map<string, Placed>>(new Map())

	useLayoutEffect(() => {
		const element = container.current
		const before = placedRef.current
		const placed = new Map<string, Placed>()

		placedRef.current = placed

		if (element === null) {
			return
		}

		// Asked only once a row changed group, as most commits are progress ticks that move nothing.
		let reduced: boolean | undefined

		for (const row of element.querySelectorAll<HTMLElement>(`[${ORDER_ID_ATTRIBUTE}]`)) {
			const id = row.getAttribute(ORDER_ID_ATTRIBUTE)
			const group = row.getAttribute(ORDER_GROUP_ATTRIBUTE)

			if (id === null || group === null) {
				continue
			}

			const now: Placed = { group, x: row.offsetLeft, y: row.offsetTop }
			const was = before.get(id)

			placed.set(id, now)

			if (was === undefined || was.group === group) {
				continue
			}

			reduced ??= prefersReducedMotion()

			if (reduced) {
				continue
			}

			const dx = was.x - now.x
			const dy = was.y - now.y

			if (dx !== 0 || dy !== 0) {
				row.animate([{ transform: `translate(${String(dx)}px, ${String(dy)}px)` }, { transform: "none" }], {
					duration: MOVE_DURATION_MS,
					easing: "cubic-bezier(0.2, 0, 0, 1)"
				})
			}
		}
	})
}
