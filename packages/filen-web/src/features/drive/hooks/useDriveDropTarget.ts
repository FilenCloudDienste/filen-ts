import { useEffect, useRef, useState, type DragEvent } from "react"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { isInternalDrag, getDragPayload, performMove } from "@/features/drive/lib/dnd"
import { isValidMoveTarget } from "@/features/drive/lib/dnd.logic"

// Hover-dwell before a collapsed tree node auto-expands under an internal drag — long enough not to
// fire while merely passing over, short enough to feel responsive.
const DWELL_EXPAND_MS = 700

export interface DriveDropTargetParams {
	// The drop target's own uuid — null for the drive root.
	targetUuid: string | null
	// The target's root-to-target uuid chain, inclusive of the target itself; empty for the root.
	targetAncestry: readonly string[]
	// Auto-expand callback for a collapsed tree node — fired once after a dwell while a valid internal
	// drag hovers. Omitted for targets that don't expand (rows, breadcrumb, an already-open node).
	onDwell?: (() => void) | undefined
	// Inert when true (a non-directory row, a non-drive variant) — never highlights, never accepts a drop.
	disabled?: boolean
}

export interface DriveDropTarget {
	isOver: boolean
	onDragEnter: (event: DragEvent<HTMLElement>) => void
	onDragOver: (event: DragEvent<HTMLElement>) => void
	onDragLeave: (event: DragEvent<HTMLElement>) => void
	onDrop: (event: DragEvent<HTMLElement>) => void
}

// A move drop target — shared by directory rows/tiles, the sidebar tree nodes + root, and the
// breadcrumb ancestors. Only reacts to INTERNAL drags (the marker), so an external file drag falls
// straight through to the wrapping upload dropzone; an internal drag it accepts is claimed with
// stopPropagation so that same dropzone never double-handles it. Mutable per-drag tracking (enter/
// leave depth, the dwell timer) lives in refs and the rendered highlight flows through setState —
// keeping the pointer-tracking compiler-safe.
export function useDriveDropTarget({ targetUuid, targetAncestry, onDwell, disabled = false }: DriveDropTargetParams): DriveDropTarget {
	const [isOver, setIsOver] = useState(false)
	// dragenter/dragleave bubble from every descendant the cursor crosses — a depth counter keeps the
	// highlight steady across inner elements (same reason as uploadDropzone.logic.ts).
	const depthRef = useRef(0)
	const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// The dwell timer captures onDwell; a re-render must not leave it calling a stale callback — read
	// the latest through a ref (keeps the async path compiler-safe).
	const onDwellRef = useRef(onDwell)

	useEffect(() => {
		onDwellRef.current = onDwell
	})

	function clearDwell(): void {
		if (dwellRef.current !== null) {
			clearTimeout(dwellRef.current)
			dwellRef.current = null
		}
	}

	// A valid move here needs the internal marker AND a payload (read from the module ref, since the
	// transfer's data is unreadable mid-drag) that clears the self/descendant/same-parent guards.
	function isValid(event: DragEvent<HTMLElement>): boolean {
		if (disabled || !isInternalDrag(event.dataTransfer)) {
			return false
		}

		return isValidMoveTarget({
			targetUuid,
			targetAncestry,
			payload: getDragPayload(),
			rootUuid: currentRootUuid()
		})
	}

	function onDragEnter(event: DragEvent<HTMLElement>): void {
		if (!isValid(event)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		depthRef.current += 1
		setIsOver(true)

		if (onDwellRef.current && dwellRef.current === null) {
			dwellRef.current = setTimeout(() => {
				dwellRef.current = null
				onDwellRef.current?.()
			}, DWELL_EXPAND_MS)
		}
	}

	function onDragOver(event: DragEvent<HTMLElement>): void {
		if (!isValid(event)) {
			return
		}

		// preventDefault marks this element as a drop target so onDrop can fire; stopPropagation keeps
		// the wrapping upload dropzone from also claiming this internal drag.
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = "move"
	}

	function onDragLeave(event: DragEvent<HTMLElement>): void {
		if (disabled || !isInternalDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		depthRef.current = Math.max(0, depthRef.current - 1)

		if (depthRef.current === 0) {
			setIsOver(false)
			clearDwell()
		}
	}

	function onDrop(event: DragEvent<HTMLElement>): void {
		depthRef.current = 0
		clearDwell()

		if (!isValid(event)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		setIsOver(false)
		void performMove(getDragPayload(), targetUuid)
	}

	// Cancel any pending dwell on unmount (navigation away mid-drag). Mount/unmount-only teardown.
	useEffect(() => {
		return () => {
			clearDwell()
		}
	}, [])

	return { isOver, onDragEnter, onDragOver, onDragLeave, onDrop }
}
