import { FileIcon, FolderIcon, type LucideIcon } from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

// Placeholder seam: every item resolves to one of two generic icons today. A later preview slice
// wires per-extension icons from src/assets/file-icons/ behind this same signature. A shared
// directory reads as a directory, a shared file as a file (asDirectoryOrFile).
export function fileIconFor(item: DriveItem): LucideIcon {
	return asDirectoryOrFile(item).type === "directory" ? FolderIcon : FileIcon
}
