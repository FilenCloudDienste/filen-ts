import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"

// Files dragged in from the operating system, as opposed to an internal drive drag (dnd.ts's marker).
export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
	return dataTransfer?.types.includes("Files") ?? false
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

	if (entries.some(entry => entry.isDirectory)) {
		void startDirectoryUpload({ kind: "entries", entries }, parentUuid)

		return
	}

	void startUploads(Array.from(dataTransfer.files), parentUuid)
}
