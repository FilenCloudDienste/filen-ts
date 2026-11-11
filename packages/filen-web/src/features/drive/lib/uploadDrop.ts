import { dragOutActive } from "@/features/drive/lib/dragOut"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { nativeTransfersAvailable } from "@/features/transfers/lib/nativeHost"
import { startNativeDrop } from "@/features/transfers/lib/nativeTransfers"

// Files dragged in from the operating system. Not while our own drive items are dragged out (dragOut.ts): that drag
// coming back over the window, onto the dropzone, a directory row, the tree or the sidebar root, uploads nothing.
export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
	return (dataTransfer?.types.includes("Files") ?? false) && !dragOutActive()
}

// Uploads what an OS drag dropped into `parentUuid`: a drop holding a directory recreates its tree, a
// plain set of files uploads as picked. Shared by the listing's dropzone and the directory drop targets
// in it.
export function uploadDroppedFiles(dataTransfer: DataTransfer, parentUuid: string | null): void {
	const entries: FileSystemEntry[] = []

	for (const item of Array.from(dataTransfer.items)) {
		const entry = item.webkitGetAsEntry()

		if (entry !== null) {
			entries.push(entry)
		}
	}

	// On desktop the native host uploads from the dropped paths; the drop's Files and entries are read now, while
	// the event still holds them.
	if (nativeTransfersAvailable()) {
		void startNativeDrop(Array.from(dataTransfer.files), entries, parentUuid)

		return
	}

	if (entries.some(entry => entry.isDirectory)) {
		void startDirectoryUpload({ kind: "entries", entries }, parentUuid)

		return
	}

	void startUploads(Array.from(dataTransfer.files), parentUuid)
}
