import { FileIcon, FolderIcon, type LucideIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"

// Placeholder seam: every item resolves to one of two generic icons today. A later preview slice
// wires per-extension icons from src/assets/file-icons/ behind this same signature.
export function fileIconFor(item: DriveItem): LucideIcon {
	return item.type === "directory" ? FolderIcon : FileIcon
}
