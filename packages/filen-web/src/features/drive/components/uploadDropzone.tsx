import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { UploadIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { uploadDroppedFiles } from "@/features/drive/lib/uploadDrop"
import { isInternalDrag } from "@/features/drive/lib/dnd"
import { enterDragDepth, leaveDragDepth } from "@/features/drive/components/uploadDropzone.logic"
import { useUploadDropTargetStore } from "@/features/drive/store/useUploadDropTargetStore"
import { cachedDirectoryName } from "@/features/drive/queries/drive"

export interface UploadDropzoneProps {
	// The directory dropped files land in — the current listing's own uuid (null at My Drive's root).
	parentUuid: string | null
	// True outside a writable location (canWriteVariant — the "drive" variant, or an owned nested
	// sharedOut directory) or while the listing hasn't loaded yet — mirrors NewDirectory/UploadMenu's
	// disabled-not-hidden convention. The zone never highlights or starts an upload while disabled —
	// defense-in-depth alongside the mount-point gate in directoryListing.tsx.
	disabled?: boolean
	children: ReactNode
}

// Drop target wrapping the listing's list/scroll area (mounted in directoryListing.tsx). A drop
// carrying at least one directory (DataTransferItem.webkitGetAsEntry returning a
// FileSystemDirectoryEntry) goes through the tree-walking directory-upload path; a plain files-only
// drop keeps using the flat startUploads path unchanged.
//
// The highlight uses a depth counter (uploadDropzone.logic.ts) rather than a plain dragover/
// dragleave boolean: dragenter/dragleave bubble up from every descendant the cursor crosses, and a
// naive boolean would flicker the highlight off each time it passes over a row inside the zone.
//
// A separate window-level guard below preventDefaults dragover/drop globally (not just inside this
// zone) so a stray drop anywhere on the page can't make the browser navigate away to open the file.
// Scoped to this component's own mount lifecycle, same as every other subscription effect in this
// codebase (see themeProvider.tsx's storage listener) — added on mount, removed on unmount.
export function UploadDropzone({ parentUuid, disabled = false, children }: UploadDropzoneProps) {
	const { t } = useTranslation("drive")
	const [dragDepth, setDragDepth] = useState(0)
	const active = !disabled && dragDepth > 0
	const targetName = useUploadDropTargetStore(state => state.target?.name ?? null)
	// The bottom strip always takes a drop for the directory on screen, which rows could otherwise cover
	// entirely when it holds nothing but directories.
	const [overStrip, setOverStrip] = useState(false)
	const stripRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const preventNavigation = (event: globalThis.DragEvent) => {
			event.preventDefault()
		}

		window.addEventListener("dragover", preventNavigation)
		window.addEventListener("drop", preventNavigation)

		return () => {
			window.removeEventListener("dragover", preventNavigation)
			window.removeEventListener("drop", preventNavigation)
		}
	}, [])

	// An INTERNAL move drag (a row/tile dragged within the drive — see dnd.ts) is never an upload: bow
	// out entirely so no upload hint overlay shows and no drop starts an upload. The move drop targets
	// (directory rows, tree, breadcrumb) claim it instead. Returning WITHOUT preventDefault also leaves
	// the browser rejecting this zone as a drop target for the internal drag, so a stray internal drop
	// on blank listing space is a harmless no-op rather than an upload.
	// Enters and leaves are counted in the capture phase: a directory inside claims a file drag of its own
	// (useDriveDropTarget) and stops it from bubbling, yet the overlay stays up over it, naming it.
	function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
		if (isInternalDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()

		if (disabled) {
			return
		}

		setDragDepth(enterDragDepth)
	}

	function handleDragOver(event: DragEvent<HTMLDivElement>): void {
		if (isInternalDrag(event.dataTransfer)) {
			return
		}

		// Required for onDrop to fire at all (the browser default rejects the element as a drop
		// target) — no state change here, dragenter/dragleave alone drive the depth counter.
		event.preventDefault()
	}

	function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
		if (isInternalDrag(event.dataTransfer)) {
			return
		}

		if (disabled) {
			return
		}

		setDragDepth(leaveDragDepth)
	}

	function handleDrop(event: DragEvent<HTMLDivElement>): void {
		if (isInternalDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		setDragDepth(0)
		setOverStrip(false)

		if (disabled) {
			return
		}

		uploadDroppedFiles(event.dataTransfer, parentUuid)
	}

	// Read only while the overlay shows: finding a name scans the cached listings.
	function currentDirectoryHint(): string {
		const name = parentUuid === null ? t("driveMyDrive") : cachedDirectoryName(parentUuid)

		return name === undefined || name.length === 0 ? t("driveUploadDropHereHint") : t("driveUploadDropHereHintInto", { name })
	}

	return (
		<div
			className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
			onDragEnterCapture={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeaveCapture={handleDragLeave}
			// A directory inside claims a file drop of its own (useDriveDropTarget), and the bubbling drop
			// then never reaches this zone; its hint still has to go. Not for a drop on the strip: React
			// flushes this update before the bubble phase, and an unmounted target never bubbles to onDrop.
			onDropCapture={event => {
				if (event.target instanceof Node && stripRef.current?.contains(event.target)) {
					return
				}

				setDragDepth(0)
				setOverStrip(false)
			}}
			onDrop={handleDrop}
		>
			{children}
			{active ? (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-10 flex flex-col border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary"
				>
					<div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4">
						<UploadIcon className="size-5 shrink-0" />
						<span className="min-w-0 truncate">
							{targetName === null ? t("driveUploadDropHint") : t("driveUploadDropHintInto", { name: targetName })}
						</span>
					</div>
					{/* Not a directory row, so a drop here falls through to this zone's own upload. Its content
					    ignores the pointer so the strip's own enter/leave pair up. */}
					<div
						ref={stripRef}
						onDragEnter={() => {
							setOverStrip(true)
						}}
						onDragLeave={() => {
							setOverStrip(false)
						}}
						className={cn(
							"pointer-events-auto flex h-11 shrink-0 items-center justify-center gap-2 border-t-2 border-dashed border-primary bg-background/95 px-4 transition-colors *:pointer-events-none",
							overStrip && "bg-primary/15"
						)}
					>
						<UploadIcon className="size-4 shrink-0" />
						<span className="min-w-0 truncate">{currentDirectoryHint()}</span>
					</div>
				</div>
			) : null}
		</div>
	)
}
