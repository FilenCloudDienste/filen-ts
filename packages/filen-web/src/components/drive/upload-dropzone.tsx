import { useEffect, useState, type DragEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { UploadIcon } from "lucide-react"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { enterDragDepth, leaveDragDepth } from "@/components/drive/upload-dropzone.logic"

export interface UploadDropzoneProps {
	// The directory dropped files land in — the current listing's own uuid (null at My Drive's root).
	parentUuid: string | null
	// True outside the "drive" variant (recents/favorites/trash/shared have no navigable directory to
	// upload into) or while the listing hasn't loaded yet — mirrors NewDirectory/UploadMenu's
	// disabled-not-hidden convention. The zone never highlights or starts an upload while disabled —
	// defense-in-depth alongside the mount-point gate in directory-listing.tsx.
	disabled?: boolean
	children: ReactNode
}

// Drop target wrapping the listing's list/scroll area (mounted in directory-listing.tsx). A drop
// carrying at least one directory (DataTransferItem.webkitGetAsEntry returning a
// FileSystemDirectoryEntry) goes through the tree-walking directory-upload path; a plain files-only
// drop keeps using the flat startUploads path unchanged.
//
// The highlight uses a depth counter (upload-dropzone.logic.ts) rather than a plain dragover/
// dragleave boolean: dragenter/dragleave bubble up from every descendant the cursor crosses, and a
// naive boolean would flicker the highlight off each time it passes over a row inside the zone.
//
// A separate window-level guard below preventDefaults dragover/drop globally (not just inside this
// zone) so a stray drop anywhere on the page can't make the browser navigate away to open the file.
// Scoped to this component's own mount lifecycle, same as every other subscription effect in this
// codebase (see theme-provider.tsx's storage listener) — added on mount, removed on unmount.
export function UploadDropzone({ parentUuid, disabled = false, children }: UploadDropzoneProps) {
	const { t } = useTranslation("drive")
	const [dragDepth, setDragDepth] = useState(0)
	const active = !disabled && dragDepth > 0

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

	function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
		event.preventDefault()

		if (disabled) {
			return
		}

		setDragDepth(enterDragDepth)
	}

	function handleDragOver(event: DragEvent<HTMLDivElement>): void {
		// Required for onDrop to fire at all (the browser default rejects the element as a drop
		// target) — no state change here, dragenter/dragleave alone drive the depth counter.
		event.preventDefault()
	}

	function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
		event.preventDefault()

		if (disabled) {
			return
		}

		setDragDepth(leaveDragDepth)
	}

	function handleDrop(event: DragEvent<HTMLDivElement>): void {
		event.preventDefault()
		setDragDepth(0)

		if (disabled) {
			return
		}

		const entries: FileSystemEntry[] = []

		for (const item of Array.from(event.dataTransfer.items)) {
			const entry = item.webkitGetAsEntry()

			if (entry !== null) {
				entries.push(entry)
			}
		}

		if (entries.some(entry => entry.isDirectory)) {
			void startDirectoryUpload({ kind: "entries", entries }, parentUuid)
			return
		}

		void startUploads(Array.from(event.dataTransfer.files), parentUuid)
	}

	return (
		<div
			className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{children}
			{active ? (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary"
				>
					<UploadIcon className="size-5" />
					{t("driveUploadDropHint")}
				</div>
			) : null}
		</div>
	)
}
