import { useEffect, useRef, useState, type DragEvent } from "react"
import { onlineManager } from "@tanstack/react-query"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { getDragPayload, performMove } from "@/features/drive/lib/dnd"
import { isValidCopyTarget, isValidMoveTarget, type DragDropMode } from "@/features/drive/lib/dnd.logic"
import { registerDropTarget, type DropTargetHandlers, type DropTargetState } from "@/features/drive/lib/pointerDrag"
import { targetOwnParents } from "@/features/drive/lib/ownAncestry"
import type { ParentLookup } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { useLatestRef } from "@/lib/useLatestRef"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { isFileDrag, uploadDroppedFiles } from "@/features/drive/lib/uploadDrop"
import { armSpringLoad, cancelSpringLoad, type SpringTiming } from "@/features/drive/lib/springLoad"
import { useUploadDropTargetStore } from "@/features/drive/store/useUploadDropTargetStore"

export interface DriveDropTargetParams {
	// The drop target's own uuid — null for the drive root.
	targetUuid: string | null
	// The target's root-to-target uuid chain, inclusive of the target itself; empty for the root.
	targetAncestry: readonly string[]
	// Set for a target whose ancestry comes from the route (a listing row or tile, a breadcrumb crumb). A
	// route can start below the root (a directory opened from Favorites, Recents or a link) or skip what
	// lies between a search's root and its hit, and the sidebar tree can drag any directory, so a
	// directory drop also walks the target's real chain through the cached listings, from `parent` when
	// the target's own parent is known, and is refused where that walk can't reach the root. The tree's
	// own nodes leave this unset: their ancestry is read from the listings themselves.
	routeChain?: { parent: string | undefined } | undefined
	// The target directory's name, for the card of a copy dropped on it; a function when finding it costs
	// something, read only on that drop.
	targetName: string | (() => string)
	// Spring-loading: while a drag this target would take rests on it, `open` runs after the timing's
	// delay (springLoad.ts) — a listing directory opens, a collapsed tree node expands. Omitted where
	// nothing opens (a file row, an already-open node, an undecryptable directory).
	spring?: { timing: SpringTiming; open: () => void } | undefined
	// Also takes files dragged in from the operating system (an HTML5 drag), uploading them into this
	// directory — independent of `disabled`, which only concerns drags of drive items. Off when omitted.
	acceptFiles?: boolean
	// Inert to drags of drive items when true (a non-directory row, a non-drive variant): it never
	// registers with the drag engine, so it never highlights, accepts or springs for one. Off when omitted.
	disabled?: boolean
}

export interface DropHandlers {
	onDragEnter: (event: DragEvent<HTMLElement>) => void
	onDragOver: (event: DragEvent<HTMLElement>) => void
	onDragLeave: (event: DragEvent<HTMLElement>) => void
	onDrop: (event: DragEvent<HTMLElement>) => void
}

export interface DriveDropTarget {
	isOver: boolean
	// What a drop here would do right now, following the copy modifier.
	mode: DragDropMode
	// The hovering drag is an OS file drag, which uploads into this directory.
	upload: boolean
	// HTML5 handlers, for OS file drags only.
	handlers: DropHandlers
	// Registers the element with the pointer drag engine (pointerDrag.ts) for drags of drive items; the
	// caller merges it with any ref of its own.
	attach: (element: Element | null) => void
}

// A move (or, with the copy modifier held, copy) drop target — shared by directory rows/tiles, the sidebar
// tree nodes + root, and the breadcrumb ancestors. Drags of drive items come from the pointer drag engine
// (pointerDrag.ts), which hit-tests, picks the nearest accepting target and tells this one only when its
// state changes. An OS file drag (HTML5) is taken only where `acceptFiles` says so, claimed with
// stopPropagation so the wrapping upload dropzone never double-handles it; anything else falls straight
// through to that dropzone. Mutable per-drag tracking (enter/leave depth) lives in refs, the one
// spring-load timer in springLoad.ts, and the rendered highlight flows through setState — keeping the
// pointer-tracking compiler-safe. The optional flags are compared against true rather than given
// destructuring defaults, which the React Compiler cannot lower.
export function useDriveDropTarget({
	targetUuid,
	targetAncestry,
	routeChain,
	targetName,
	spring,
	acceptFiles,
	disabled
}: DriveDropTargetParams): DriveDropTarget {
	const [isOver, setIsOver] = useState(false)
	const [mode, setMode] = useState<DragDropMode>("move")
	const [upload, setUpload] = useState(false)
	// dragenter/dragleave bubble from every descendant the cursor crosses — a depth counter keeps the
	// hover steady across inner elements (same reason as uploadDropzone.logic.ts). Two counts: every
	// enter of a file drag this target takes part in, and the enters it CLAIMED (stopped, so an enclosing
	// target never saw them). A leave is stopped only while a claimed enter is outstanding, so whatever
	// encloses this target always sees enters and leaves in pairs, whichever way validity flips between.
	const depthRef = useRef(0)
	const claimedDepthRef = useRef(0)
	// This target's identity to the page's one spring-load timer (springLoad.ts).
	const springOwnerRef = useRef({})
	// The timer fires up to seconds after it was armed, and the drag engine calls this target long after
	// the render that registered it: neither may act on stale props (a row's index moves with a re-sort).
	// One object, so one effect per row.
	const latestRef = useLatestRef({ spring, targetName, targetUuid, targetAncestry, routeChain })
	// The element registered with the drag engine, and its unregister.
	const registeredRef = useRef<{ element: HTMLElement; unregister: () => void } | null>(null)

	// Names this directory in the listing's upload overlay while a file drag rests on it.
	useEffect(() => {
		if (!isOver || !upload) {
			return
		}

		const owner = springOwnerRef.current
		const name = latestRef.current.targetName
		const { setTarget, clearTarget } = useUploadDropTargetStore.getState()

		setTarget({ owner, name: typeof name === "function" ? name() : name })

		return () => {
			clearTarget(owner)
		}
	}, [isOver, upload, latestRef])

	function armSpring(element: HTMLElement): void {
		const current = latestRef.current.spring

		if (current !== undefined) {
			armSpringLoad(springOwnerRef.current, element, current.timing, () => {
				latestRef.current.spring?.open()
			})
		}
	}

	function cancelSpring(): void {
		cancelSpringLoad(springOwnerRef.current)
	}

	// The walk's parents, built once per drag (the payload array is the drag's identity): building them
	// scans every cached listing, and a drag is hit-tested every frame it moves. Only read when the payload
	// holds a directory.
	const walkRef = useRef<{ payload: readonly DriveItem[]; uuid: string; parents: ParentLookup } | null>(null)

	function routeChainReader(payload: readonly DriveItem[]): (() => ParentLookup) | undefined {
		const { targetUuid: uuid, routeChain: chain } = latestRef.current

		if (chain === undefined || uuid === null) {
			return undefined
		}

		const parent = chain.parent

		return () => {
			// Per target too: the listing's own background stays mounted while its directory changes.
			if (walkRef.current?.payload !== payload || walkRef.current.uuid !== uuid) {
				walkRef.current = { payload, uuid, parents: targetOwnParents({ uuid, parent, rootUuid: currentRootUuid() }) }
			}

			return walkRef.current.parents
		}
	}

	// A drop of drive items needs a payload that clears the guards for the drop's mode: a move is also
	// refused onto the payload's own parent, a copy is not.
	function acceptsItems(dropMode: DragDropMode): boolean {
		const { targetUuid: uuid, targetAncestry: ancestry } = latestRef.current
		const payload = getDragPayload()
		const readParents = routeChainReader(payload)

		return dropMode === "copy"
			? isValidCopyTarget({ targetUuid: uuid, targetAncestry: ancestry, readParents, payload })
			: isValidMoveTarget({ targetUuid: uuid, targetAncestry: ancestry, readParents, payload, rootUuid: currentRootUuid() })
	}

	// Springing only needs the directory not to be a dragged one or below one — as in Finder, a drag
	// springs through the payload's own parent, where a move would be a no-op, whatever the modifier.
	function springsForItems(): boolean {
		const { spring: current, targetUuid: uuid, targetAncestry: ancestry } = latestRef.current

		if (current === undefined) {
			return false
		}

		const payload = getDragPayload()

		return isValidCopyTarget({ targetUuid: uuid, targetAncestry: ancestry, readParents: routeChainReader(payload), payload })
	}

	function resetHover(): void {
		depthRef.current = 0
		claimedDepthRef.current = 0
		setIsOver(false)
		cancelSpring()
	}

	function dropItems(dropMode: DragDropMode): void {
		const { targetUuid: uuid, targetName: name } = latestRef.current
		const destination = { uuid, name: typeof name === "function" ? name() : name }

		resetHover()

		if (dropMode === "copy") {
			// The payload leaves the module ref once the drag ends; the copy keeps its own array.
			startCopyWithCard(getDragPayload().slice(), destination)

			return
		}

		void performMove(getDragPayload(), destination)
	}

	function updateFromEngine(state: DropTargetState | null, element: HTMLElement): void {
		if (state === null) {
			setIsOver(false)
			cancelSpring()

			return
		}

		setIsOver(state.over)
		setMode(state.mode)
		setUpload(false)

		if (state.spring) {
			armSpring(element)
		} else {
			cancelSpring()
		}
	}

	function attach(element: Element | null): void {
		const registered = registeredRef.current

		if (registered !== null && registered.element === element) {
			return
		}

		registered?.unregister()
		registeredRef.current = null

		if (element instanceof HTMLElement && disabled !== true) {
			const handlers: DropTargetHandlers = {
				accepts: acceptsItems,
				springs: springsForItems,
				update: updateFromEngine,
				drop: dropItems
			}

			registeredRef.current = { element, unregister: registerDropTarget(element, handlers) }
		}
	}

	// The OS file drag this target takes part in; it leaves any other HTML5 drag alone.
	function takesFiles(event: DragEvent<HTMLElement>): boolean {
		return acceptFiles === true && isFileDrag(event.dataTransfer)
	}

	// Files need a connection to upload over.
	function takesFileDrop(event: DragEvent<HTMLElement>): boolean {
		return takesFiles(event) && onlineManager.isOnline()
	}

	// An upload lands a copy of what was dropped, so a file drag shows as one.
	function showFileHover(): void {
		setMode("copy")
		setUpload(true)
		setIsOver(true)
	}

	function onDragEnter(event: DragEvent<HTMLElement>): void {
		if (!takesFiles(event)) {
			return
		}

		depthRef.current += 1

		// Offline, the enter is left to whatever encloses this target, but the drag may still spring.
		if (takesFileDrop(event)) {
			event.preventDefault()
			event.stopPropagation()
			claimedDepthRef.current += 1
			showFileHover()
		}

		armSpring(event.currentTarget)
	}

	function onDragOver(event: DragEvent<HTMLElement>): void {
		if (!takesFiles(event)) {
			return
		}

		if (takesFileDrop(event)) {
			// preventDefault marks this element as a drop target so onDrop can fire; stopPropagation keeps
			// an enclosing target and the upload dropzone from also claiming this drag. The drop effect
			// drives the browser's own cursor, which shows its copy badge.
			event.preventDefault()
			event.stopPropagation()
			event.dataTransfer.dropEffect = "copy"
			showFileHover()
		} else {
			setIsOver(false)
		}

		// Re-arming the armed target is a no-op.
		armSpring(event.currentTarget)
	}

	function onDragLeave(event: DragEvent<HTMLElement>): void {
		if (!takesFiles(event)) {
			return
		}

		if (claimedDepthRef.current > 0) {
			event.preventDefault()
			event.stopPropagation()
			claimedDepthRef.current -= 1
		}

		depthRef.current = Math.max(0, depthRef.current - 1)

		if (depthRef.current === 0) {
			resetHover()
		}
	}

	function onDrop(event: DragEvent<HTMLElement>): void {
		const valid = takesFileDrop(event)

		resetHover()

		if (!valid) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		uploadDroppedFiles(event.dataTransfer, targetUuid)
	}

	// A file drag that ends elsewhere — dropped on another target, dropped outside the page, or cancelled —
	// never sends this target the leave that would clear its hover. Listened for only while a file drag
	// hovers; the drag engine ends its own hovers.
	useEffect(() => {
		if (!isOver || !upload) {
			return
		}

		function clear(): void {
			depthRef.current = 0
			claimedDepthRef.current = 0
			setIsOver(false)
		}

		window.addEventListener("drop", clear, true)
		window.addEventListener("dragend", clear, true)

		return () => {
			window.removeEventListener("drop", clear, true)
			window.removeEventListener("dragend", clear, true)
		}
	}, [isOver, upload])

	// Disarm on unmount (navigation away mid-drag), unless the timer has moved on to another target, and
	// leave the drag engine. Mount/unmount-only teardown.
	useEffect(() => {
		return () => {
			cancelSpring()
			registeredRef.current?.unregister()
			registeredRef.current = null
		}
	}, [])

	return { isOver, mode, upload, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop }, attach }
}

// The hovered target's highlight: a solid ring for a move, a dashed outline for a copy, so the mode
// shows on the target as well as on the cursor. An upload stands out more, since it sits inside the
// listing's own dashed upload overlay.
export function dropHighlightClass(drop: Pick<DriveDropTarget, "isOver" | "mode" | "upload">): string | false {
	if (!drop.isOver) {
		return false
	}

	if (drop.upload) {
		return "bg-primary/15 ring-2 ring-primary ring-inset"
	}

	return drop.mode === "copy"
		? "bg-primary/10 outline-2 outline-dashed outline-primary -outline-offset-2"
		: "bg-primary/10 ring-2 ring-primary/60 ring-inset"
}
