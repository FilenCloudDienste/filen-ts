import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type DragEvent,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent
} from "react"
import { moveRailEntry, railDropIndex, railShift, type RailEntryId } from "@/features/shell/lib/railOrder.logic"

// Movement before a press turns into a drag, so a plain click still navigates.
const DRAG_THRESHOLD = 4

interface Drag {
	from: number
	deltaY: number
	pitch: number
}

interface Gesture {
	from: number
	startY: number
	pitch: number
	dragging: boolean
}

export interface RailSlotProps {
	style: CSSProperties
	dragging: boolean
	reordering: boolean
	onPointerDown: (event: PointerEvent<HTMLElement>) => void
	onClickCapture: (event: MouseEvent<HTMLElement>) => void
	onDragStart: (event: DragEvent<HTMLElement>) => void
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

// The distance between two neighboring slots, read from the list the slot sits in.
function measurePitch(slot: HTMLElement): number {
	const first = slot.parentElement?.children[0]
	const second = slot.parentElement?.children[1]

	if (first && second) {
		return second.getBoundingClientRect().top - first.getBoundingClientRect().top
	}

	return slot.getBoundingClientRect().height
}

// Drag-to-reorder for the rail's links, by pointer events rather than the drag-and-drop API: file drags
// through the app use that API, and a plain click on a link must still navigate. The grabbed slot follows
// the pointer while the others slide to open the gap where it will land; Alt+Arrow moves a focused one.
export function useRailReorder(order: readonly RailEntryId[], onReorder: (next: RailEntryId[]) => void) {
	const [drag, setDrag] = useState<Drag | null>(null)
	const gestureRef = useRef<Gesture | null>(null)
	const suppressClickRef = useRef(false)
	const cleanupRef = useRef<(() => void) | null>(null)
	const orderRef = useRef(order)
	const onReorderRef = useRef(onReorder)

	useEffect(() => {
		orderRef.current = order
		onReorderRef.current = onReorder
	}, [order, onReorder])

	useEffect(
		() => () => {
			cleanupRef.current?.()
		},
		[]
	)

	function end(commit: boolean, clientY: number): void {
		const gesture = gestureRef.current

		cleanupRef.current?.()
		cleanupRef.current = null
		gestureRef.current = null

		if (!gesture?.dragging) {
			return
		}

		setDrag(null)
		// The press ended a drag: the click it produces must not navigate.
		suppressClickRef.current = true
		setTimeout(() => {
			suppressClickRef.current = false
		}, 0)

		if (!commit) {
			return
		}

		const count = orderRef.current.length
		const to = railDropIndex(gesture.from, clientY - gesture.startY, gesture.pitch, count)

		if (to !== gesture.from) {
			onReorderRef.current(moveRailEntry(orderRef.current, gesture.from, to))
		}
	}

	function slotProps(index: number): RailSlotProps {
		const dragging = drag !== null && drag.from === index
		const to = drag === null ? index : railDropIndex(drag.from, drag.deltaY, drag.pitch, order.length)
		const offset = drag === null ? 0 : dragging ? drag.deltaY : railShift(index, drag.from, to, drag.pitch)

		return {
			style: offset === 0 && !dragging ? {} : { transform: `translateY(${String(offset)}px)${dragging ? " scale(1.08)" : ""}` },
			dragging,
			reordering: drag !== null,
			onPointerDown: event => {
				if (event.button !== 0 || event.pointerType === "touch") {
					return
				}

				cleanupRef.current?.()
				gestureRef.current = { from: index, startY: event.clientY, pitch: measurePitch(event.currentTarget), dragging: false }

				const onMove = (move: globalThis.PointerEvent): void => {
					const gesture = gestureRef.current

					if (!gesture) {
						return
					}

					const deltaY = move.clientY - gesture.startY

					if (!gesture.dragging && Math.abs(deltaY) < DRAG_THRESHOLD) {
						return
					}

					gesture.dragging = true
					setDrag({ from: gesture.from, deltaY, pitch: gesture.pitch })
				}
				const onUp = (up: globalThis.PointerEvent): void => {
					end(true, up.clientY)
				}
				const onCancel = (): void => {
					end(false, 0)
				}
				const onKey = (key: globalThis.KeyboardEvent): void => {
					if (key.key === "Escape") {
						key.preventDefault()
						end(false, 0)
					}
				}

				window.addEventListener("pointermove", onMove)
				window.addEventListener("pointerup", onUp)
				window.addEventListener("pointercancel", onCancel)
				window.addEventListener("keydown", onKey, true)
				cleanupRef.current = () => {
					window.removeEventListener("pointermove", onMove)
					window.removeEventListener("pointerup", onUp)
					window.removeEventListener("pointercancel", onCancel)
					window.removeEventListener("keydown", onKey, true)
				}
			},
			onClickCapture: event => {
				if (suppressClickRef.current) {
					event.preventDefault()
					event.stopPropagation()
				}
			},
			// A link is natively draggable; that drag would cancel the pointer stream this one relies on.
			onDragStart: event => {
				event.preventDefault()
			},
			onKeyDown: event => {
				if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
					return
				}

				const target = index + (event.key === "ArrowUp" ? -1 : 1)

				event.preventDefault()

				if (target >= 0 && target < order.length) {
					onReorder(moveRailEntry(order, index, target))
				}
			}
		}
	}

	return { slotProps }
}
