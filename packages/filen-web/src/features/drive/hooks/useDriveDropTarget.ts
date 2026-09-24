import { useEffect, useRef, useState, type DragEvent } from "react"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { isInternalDrag, getDragPayload, performMove } from "@/features/drive/lib/dnd"
import { dragDropMode, isValidCopyTarget, isValidMoveTarget, type DragDropMode } from "@/features/drive/lib/dnd.logic"
import { searchHitParents } from "@/features/drive/lib/ownAncestry"
import type { ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"

const MAC = isMacPlatform()

// Hover-dwell before a collapsed tree node auto-expands under an internal drag — long enough not to
// fire while merely passing over, short enough to feel responsive.
const DWELL_EXPAND_MS = 700

export interface DriveDropTargetParams {
	// The drop target's own uuid — null for the drive root.
	targetUuid: string | null
	// The target's root-to-target uuid chain, inclusive of the target itself; empty for the root.
	targetAncestry: readonly string[]
	// A search hit below the search root's children: its own parent, and the directory the search runs
	// in. Its chain above skips what lies between the two, so a directory drop waits on a walk of the
	// cached parents.
	searchHit?: { parent: string; searchRoot: string | null } | undefined
	// The target directory's name, for the card of a copy dropped on it.
	targetName: string
	// Auto-expand callback for a collapsed tree node — fired once after a dwell while a valid internal
	// drag hovers. Omitted for targets that don't expand (rows, breadcrumb, an already-open node).
	onDwell?: (() => void) | undefined
	// Inert when true (a non-directory row, a non-drive variant) — never highlights, never accepts a drop.
	disabled?: boolean
}

export interface DriveDropTarget {
	isOver: boolean
	// What a drop here would do right now, following the copy modifier.
	mode: DragDropMode
	onDragEnter: (event: DragEvent<HTMLElement>) => void
	onDragOver: (event: DragEvent<HTMLElement>) => void
	onDragLeave: (event: DragEvent<HTMLElement>) => void
	onDrop: (event: DragEvent<HTMLElement>) => void
}

// A move (or, with the copy modifier held, copy) drop target — shared by directory rows/tiles, the sidebar tree nodes + root, and the
// breadcrumb ancestors. Only reacts to INTERNAL drags (the marker), so an external file drag falls
// straight through to the wrapping upload dropzone; an internal drag it accepts is claimed with
// stopPropagation so that same dropzone never double-handles it. Mutable per-drag tracking (enter/
// leave depth, the dwell timer) lives in refs and the rendered highlight flows through setState —
// keeping the pointer-tracking compiler-safe.
export function useDriveDropTarget({
	targetUuid,
	targetAncestry,
	searchHit,
	targetName,
	onDwell,
	disabled = false
}: DriveDropTargetParams): DriveDropTarget {
	const [isOver, setIsOver] = useState(false)
	const [mode, setMode] = useState<DragDropMode>("move")
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

	// Only read when the payload holds a directory: the walk reads every cached listing.
	function searchHitParentReader(): (() => ParentLookup) | undefined {
		if (searchHit === undefined || targetUuid === null) {
			return undefined
		}

		const hit = { uuid: targetUuid, ...searchHit }

		return () => searchHitParents({ ...hit, rootUuid: currentRootUuid() })
	}

	// A valid drop here needs the internal marker AND a payload (read from the module ref, since the
	// transfer's data is unreadable mid-drag) that clears the guards for the drop's mode: a move is also
	// refused onto the payload's own parent, a copy is not.
	function isValid(event: DragEvent<HTMLElement>): boolean {
		if (disabled || !isInternalDrag(event.dataTransfer)) {
			return false
		}

		const payload = getDragPayload()
		const readParents = searchHitParentReader()

		return dragDropMode(event, MAC) === "copy"
			? isValidCopyTarget({ targetUuid, targetAncestry, readParents, payload })
			: isValidMoveTarget({ targetUuid, targetAncestry, readParents, payload, rootUuid: currentRootUuid() })
	}

	function onDragEnter(event: DragEvent<HTMLElement>): void {
		if (!isValid(event)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		depthRef.current += 1
		setMode(dragDropMode(event, MAC))
		setIsOver(true)

		if (onDwellRef.current && dwellRef.current === null) {
			dwellRef.current = setTimeout(() => {
				dwellRef.current = null
				onDwellRef.current?.()
			}, DWELL_EXPAND_MS)
		}
	}

	function onDragOver(event: DragEvent<HTMLElement>): void {
		const next = dragDropMode(event, MAC)

		// The modifier can change while hovering, and with it whether this target takes the drop.
		if (!isValid(event)) {
			if (isInternalDrag(event.dataTransfer) && !disabled) {
				setIsOver(false)
			}

			return
		}

		// preventDefault marks this element as a drop target so onDrop can fire; stopPropagation keeps
		// the wrapping upload dropzone from also claiming this internal drag. The drop effect drives the
		// browser's own cursor, which shows its copy badge for a copy.
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = next
		setMode(next)
		setIsOver(true)
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

		if (dragDropMode(event, MAC) === "copy") {
			// The payload leaves the module ref on dragend; the copy keeps its own array.
			startCopyWithCard(getDragPayload().slice(), { uuid: targetUuid, name: targetName })

			return
		}

		void performMove(getDragPayload(), targetUuid)
	}

	// Cancel any pending dwell on unmount (navigation away mid-drag). Mount/unmount-only teardown.
	useEffect(() => {
		return () => {
			clearDwell()
		}
	}, [])

	return { isOver, mode, onDragEnter, onDragOver, onDragLeave, onDrop }
}

// The hovered target's highlight: a solid ring for a move, a dashed outline for a copy, so the mode
// shows on the target as well as on the browser's cursor.
export function dropHighlightClass(drop: Pick<DriveDropTarget, "isOver" | "mode">): string | false {
	if (!drop.isOver) {
		return false
	}

	return drop.mode === "copy"
		? "bg-primary/10 outline-2 outline-dashed outline-primary -outline-offset-2"
		: "bg-primary/10 ring-2 ring-primary/60 ring-inset"
}
