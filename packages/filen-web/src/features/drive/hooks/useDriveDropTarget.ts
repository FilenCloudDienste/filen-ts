import { useEffect, useRef, useState, type DragEvent } from "react"
import { onlineManager } from "@tanstack/react-query"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { isInternalDrag, getDragPayload, performMove } from "@/features/drive/lib/dnd"
import { dragDropMode, isValidCopyTarget, isValidMoveTarget, type DragDropMode } from "@/features/drive/lib/dnd.logic"
import { targetOwnParents } from "@/features/drive/lib/ownAncestry"
import type { ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { isFileDrag, uploadDroppedFiles } from "@/features/drive/lib/uploadDrop"
import { armSpringLoad, cancelSpringLoad, type SpringTiming } from "@/features/drive/lib/springLoad"
import { useUploadDropTargetStore } from "@/features/drive/store/useUploadDropTargetStore"

const MAC = isMacPlatform()

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
	// Also takes files dragged in from the operating system, uploading them into this directory —
	// independent of `disabled`, which only concerns internal drags.
	acceptFiles?: boolean
	// Inert to internal drags when true (a non-directory row, a non-drive variant) — never highlights,
	// never accepts one, never springs for one.
	disabled?: boolean
}

export interface DriveDropTarget {
	isOver: boolean
	// What a drop here would do right now, following the copy modifier.
	mode: DragDropMode
	// The hovering drag is an OS file drag, which uploads into this directory.
	upload: boolean
	onDragEnter: (event: DragEvent<HTMLElement>) => void
	onDragOver: (event: DragEvent<HTMLElement>) => void
	onDragLeave: (event: DragEvent<HTMLElement>) => void
	onDrop: (event: DragEvent<HTMLElement>) => void
}

// A move (or, with the copy modifier held, copy) drop target — shared by directory rows/tiles, the sidebar tree nodes + root, and the
// breadcrumb ancestors. Reacts to INTERNAL drags (the marker), and to an OS file drag only where
// `acceptFiles` says so; anything else falls straight through to the wrapping upload dropzone. A drag
// it accepts is claimed with stopPropagation so that same dropzone never double-handles it. Mutable
// per-drag tracking (enter/leave depth) lives in refs, the one spring-load timer in springLoad.ts, and
// the rendered highlight flows through setState — keeping the pointer-tracking compiler-safe.
export function useDriveDropTarget({
	targetUuid,
	targetAncestry,
	routeChain,
	targetName,
	spring,
	acceptFiles = false,
	disabled = false
}: DriveDropTargetParams): DriveDropTarget {
	const [isOver, setIsOver] = useState(false)
	const [mode, setMode] = useState<DragDropMode>("move")
	const [upload, setUpload] = useState(false)
	// dragenter/dragleave bubble from every descendant the cursor crosses — a depth counter keeps the
	// hover steady across inner elements (same reason as uploadDropzone.logic.ts). Two counts: every
	// enter of a drag this target takes part in, and the enters it CLAIMED (stopped, so an enclosing
	// target never saw them). A leave is stopped only while a claimed enter is outstanding, so whatever
	// encloses this target always sees enters and leaves in pairs, whichever way validity flips between.
	const depthRef = useRef(0)
	const claimedDepthRef = useRef(0)
	// This target's identity to the page's one spring-load timer (springLoad.ts).
	const springOwnerRef = useRef({})
	// The timer fires up to seconds after it was armed; a re-render must not leave it calling a stale
	// `open` (a row's index moves with a re-sort) — read the latest through a ref (keeps the async path
	// compiler-safe).
	const springRef = useRef(spring)

	const targetNameRef = useRef(targetName)

	useEffect(() => {
		springRef.current = spring
		targetNameRef.current = targetName
	})

	// Names this directory in the listing's upload overlay while a file drag rests on it.
	useEffect(() => {
		if (!isOver || !upload) {
			return
		}

		const owner = springOwnerRef.current
		const name = targetNameRef.current
		const { setTarget, clearTarget } = useUploadDropTargetStore.getState()

		setTarget({ owner, name: typeof name === "function" ? name() : name })

		return () => {
			clearTarget(owner)
		}
	}, [isOver, upload])

	function armSpring(element: HTMLElement): void {
		const current = springRef.current

		if (current !== undefined) {
			armSpringLoad(springOwnerRef.current, element, current.timing, () => {
				springRef.current?.open()
			})
		}
	}

	function cancelSpring(): void {
		cancelSpringLoad(springOwnerRef.current)
	}

	// The walk's parents, built once per drag (the payload array is the drag's identity): building them
	// scans every cached listing, and dragover fires many times a second. Only read when the payload
	// holds a directory.
	const walkRef = useRef<{ payload: readonly DriveItem[]; uuid: string; parents: ParentLookup } | null>(null)

	function routeChainReader(payload: readonly DriveItem[]): (() => ParentLookup) | undefined {
		if (routeChain === undefined || targetUuid === null) {
			return undefined
		}

		const uuid = targetUuid
		const parent = routeChain.parent

		return () => {
			// Per target too: the listing's own background stays mounted while its directory changes.
			if (walkRef.current?.payload !== payload || walkRef.current.uuid !== uuid) {
				walkRef.current = { payload, uuid, parents: targetOwnParents({ uuid, parent, rootUuid: currentRootUuid() }) }
			}

			return walkRef.current.parents
		}
	}

	// Which drag this target takes part in: an internal one unless `disabled`, an OS file drag where it
	// takes files, or none (it then leaves the event alone).
	function dragKind(event: DragEvent<HTMLElement>): "internal" | "files" | null {
		if (isInternalDrag(event.dataTransfer)) {
			return disabled ? null : "internal"
		}

		return acceptFiles && isFileDrag(event.dataTransfer) ? "files" : null
	}

	// A valid internal drop needs a payload (read from the module ref, since the transfer's data is
	// unreadable mid-drag) that clears the guards for the drop's mode: a move is also refused onto the
	// payload's own parent, a copy is not. Files only need a connection to upload over.
	function isValid(event: DragEvent<HTMLElement>): boolean {
		const kind = dragKind(event)

		if (kind !== "internal") {
			return kind === "files" && onlineManager.isOnline()
		}

		const payload = getDragPayload()
		const readParents = routeChainReader(payload)

		return dragDropMode(event, MAC) === "copy"
			? isValidCopyTarget({ targetUuid, targetAncestry, readParents, payload })
			: isValidMoveTarget({ targetUuid, targetAncestry, readParents, payload, rootUuid: currentRootUuid() })
	}

	// Springing only needs the directory not to be a dragged one or below one — as in Finder, a drag
	// springs through the payload's own parent, where a move would be a no-op, whatever the modifier.
	function canSpring(event: DragEvent<HTMLElement>): boolean {
		const kind = dragKind(event)

		if (springRef.current === undefined || kind === null) {
			return false
		}

		if (kind === "files") {
			return true
		}

		const payload = getDragPayload()

		return isValidCopyTarget({ targetUuid, targetAncestry, readParents: routeChainReader(payload), payload })
	}

	function updateSpring(event: DragEvent<HTMLElement>): void {
		if (canSpring(event)) {
			armSpring(event.currentTarget)
		} else {
			cancelSpring()
		}
	}

	// An upload lands a copy of what was dropped, so a file drag shows as one.
	function dropMode(event: DragEvent<HTMLElement>): DragDropMode {
		return dragKind(event) === "files" ? "copy" : dragDropMode(event, MAC)
	}

	function resetHover(): void {
		depthRef.current = 0
		claimedDepthRef.current = 0
		setIsOver(false)
		cancelSpring()
	}

	function onDragEnter(event: DragEvent<HTMLElement>): void {
		if (dragKind(event) === null) {
			return
		}

		depthRef.current += 1

		// An invalid target leaves the enter to whatever encloses it (the listing's own space takes a
		// drop that no row does), but may still spring.
		if (isValid(event)) {
			event.preventDefault()
			event.stopPropagation()
			claimedDepthRef.current += 1
			setMode(dropMode(event))
			setUpload(dragKind(event) === "files")
			setIsOver(true)
		}

		updateSpring(event)
	}

	function onDragOver(event: DragEvent<HTMLElement>): void {
		if (dragKind(event) === null) {
			return
		}

		// The modifier can change while hovering, and with it whether this target takes the drop.
		if (isValid(event)) {
			const next = dropMode(event)

			// preventDefault marks this element as a drop target so onDrop can fire; stopPropagation keeps
			// an enclosing target and the upload dropzone from also claiming this drag. The drop effect
			// drives the browser's own cursor, which shows its copy badge for a copy.
			event.preventDefault()
			event.stopPropagation()
			event.dataTransfer.dropEffect = next
			setMode(next)
			setUpload(dragKind(event) === "files")
			setIsOver(true)
		} else {
			setIsOver(false)
		}

		// Re-arming the armed target is a no-op.
		updateSpring(event)
	}

	function onDragLeave(event: DragEvent<HTMLElement>): void {
		if (dragKind(event) === null) {
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
		const valid = isValid(event)

		resetHover()

		if (!valid) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (dragKind(event) === "files") {
			uploadDroppedFiles(event.dataTransfer, targetUuid)

			return
		}

		if (dragDropMode(event, MAC) === "copy") {
			// The payload leaves the module ref on dragend; the copy keeps its own array.
			startCopyWithCard(getDragPayload().slice(), {
				uuid: targetUuid,
				name: typeof targetName === "function" ? targetName() : targetName
			})

			return
		}

		void performMove(getDragPayload(), targetUuid)
	}

	// A drag that ends elsewhere — dropped on another target, dropped outside the page, or cancelled —
	// never sends this target the leave that would clear its hover. Listened for only while hovered.
	useEffect(() => {
		if (!isOver) {
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
	}, [isOver])

	// Disarm on unmount (navigation away mid-drag), unless the timer has moved on to another target.
	// Mount/unmount-only teardown.
	useEffect(() => {
		return () => {
			cancelSpring()
		}
	}, [])

	return { isOver, mode, upload, onDragEnter, onDragOver, onDragLeave, onDrop }
}

// The hovered target's highlight: a solid ring for a move, a dashed outline for a copy, so the mode
// shows on the target as well as on the browser's cursor. An upload stands out more, since it sits
// inside the listing's own dashed upload overlay.
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
