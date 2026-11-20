import { extensionForMime, extensionOf } from "@filen/shared"

// The files a paste event carries, read while the event still holds them: `files` where the browser fills it, else the
// items of kind "file" (a copied bitmap some browsers hand over only as an item).
export function clipboardFiles(data: DataTransfer | null): File[] {
	if (data === null) {
		return []
	}

	if (data.files.length > 0) {
		return Array.from(data.files)
	}

	const files: File[] = []

	for (const item of Array.from(data.items)) {
		const file = item.kind === "file" ? item.getAsFile() : null

		if (file !== null) {
			files.push(file)
		}
	}

	return files
}

// The directory entries among a paste's items (files copied in a file manager), for the drop path's tree walk.
export function clipboardEntries(data: DataTransfer | null): FileSystemEntry[] {
	const entries: FileSystemEntry[] = []

	for (const item of data === null ? [] : Array.from(data.items)) {
		const entry = item.kind === "file" && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null

		if (entry !== null) {
			entries.push(entry)
		}
	}

	return entries
}

// How recent a file named like the browsers' bitmap placeholder must be to count as one. A bitmap is made into a file
// as it is pasted; a file copied in a file manager keeps its own, older modification time.
const PLACEHOLDER_FRESH_MS = 60_000

// A copied bitmap (a screenshot, an image copied from a page) comes without a name of its own: none at all, or the
// browsers' placeholder "image.<ext>" made as it was pasted. `now` is the paste's time.
export function isUnnamedClipboardFile(file: File, now: number): boolean {
	return (
		file.name.length === 0 ||
		(file.type.startsWith("image/") &&
			/^image\.[a-z0-9]+$/i.test(file.name) &&
			Math.abs(now - file.lastModified) <= PLACEHOLDER_FRESH_MS)
	)
}

function pad(value: number): string {
	return String(value).padStart(2, "0")
}

// Local time as a file name may hold it everywhere (no ":"): "2026-11-20 14.03.05".
export function clipboardNameTime(date: Date): string {
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
}

// The stems an unnamed pasted file is named by, localised by the caller: an image's, and any other file's.
export interface PastedFileStems {
	readonly image: string
	readonly file: string
}

// The pasted files as they upload: an unnamed one is named by its stem with its type's extension, numbered from the
// second of that stem on so one paste's files never share a name. Named files keep theirs. `now` is the paste's time.
export function namePastedFiles(files: readonly File[], stems: PastedFileStems, now: number): File[] {
	const counts = { image: 0, file: 0 }

	return files.map(file => {
		if (!isUnnamedClipboardFile(file, now)) {
			return file
		}

		const kind = file.type.startsWith("image/") ? "image" : "file"

		counts[kind]++

		const count = counts[kind]
		const extension = extensionForMime(file.type) ?? extensionOf(file.name)
		const stem = count === 1 ? stems[kind] : `${stems[kind]} (${String(count)})`

		return new File([file], extension.length > 0 ? `${stem}.${extension}` : stem, {
			type: file.type,
			lastModified: file.lastModified
		})
	})
}

// The keys the browser itself turns into a paste event: mod+v (with or without Shift) and Shift+Insert. Any other key
// a user bound to Paste fires no paste event, so the shortcut pastes on its own.
export function isNativePasteKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
	if (event.altKey) {
		return false
	}

	return (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) || (event.key === "Insert" && event.shiftKey)
}
