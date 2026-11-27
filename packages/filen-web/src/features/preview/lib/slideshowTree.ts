import type { AnyLinkedDir, DirPublicLink, File, LinkedDir } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"

// A slideshow's "include subdirectories" list: every slideable file below one directory, in directory path then
// natural name order. The worker returns slideable files only, already ordered (slideshowOrder.ts), so this never sees
// the rest of the tree and sorts nothing on the main thread.

// `hideDotFiles` and `dotFilenRoot` are the opening listing's own rules (`dotFilenRoot` is the drive root uuid
// while the root `.filen` is hidden, else null); a public link never hides.
export type SlideshowSource =
	| { kind: "owned"; uuid: string; hideDotFiles: boolean; dotFilenRoot: string | null }
	| { kind: "shared"; variant: "sharedIn" | "sharedOut"; uuid: string; path: readonly string[]; hideDotFiles: boolean }
	| { kind: "linked"; dir: AnyLinkedDir; link: DirPublicLink }

interface TreeListing {
	// In the slideshow's order, without what the listing hides (the worker's slideshowOrder).
	files: readonly File[]
	narrow: (file: File) => DriveItem
	// A link's directories as listed, for the listings beside its files (a video's subtitles).
	linkedDirs: readonly LinkedDir[]
}

type LinkedSource = Extract<SlideshowSource, { kind: "linked" }>

// A link's tree: its slideable files in order, and its directories by uuid.
export interface LinkedSlideshowTree {
	items: DriveItem[]
	dirs: ReadonlyMap<string, LinkedDir>
}

async function listTree(source: SlideshowSource): Promise<TreeListing> {
	switch (source.kind) {
		case "owned": {
			const { files } = await sdkApi.listSlideshowOwned(source.uuid, {
				hideDotFiles: source.hideDotFiles,
				dotFilenRoot: source.dotFilenRoot
			})

			return { files, narrow: narrowItem, linkedDirs: [] }
		}
		case "shared": {
			const { files, role } = await sdkApi.listSlideshowShared(
				source.uuid,
				{ hideDotFiles: source.hideDotFiles, dotFilenRoot: null },
				{ variant: source.variant, path: [...source.path] }
			)

			return { files, narrow: file => narrowItem({ ...file, sharingRole: role }), linkedDirs: [] }
		}
		case "linked": {
			const { dirs, files } = await sdkApi.listSlideshowLinked(source.dir, source.link)

			return { files, narrow: narrowItem, linkedDirs: dirs }
		}
	}
}

function itemsOf(listing: TreeListing): DriveItem[] {
	return listing.files.map(file => listing.narrow(file))
}

// An abort resolves to an empty list, so a superseded fetch never lands.
export async function fetchSlideshowTree(source: SlideshowSource, signal: AbortSignal): Promise<DriveItem[]> {
	const listing = signal.aborted ? null : await listTree(source)

	return listing === null || signal.aborted ? [] : itemsOf(listing)
}

// fetchSlideshowTree for a link, with its directories (which it lists anyway) kept beside the files.
export async function fetchLinkedSlideshowTree(source: LinkedSource, signal: AbortSignal): Promise<LinkedSlideshowTree> {
	const listing = signal.aborted ? null : await listTree(source)

	if (listing === null || signal.aborted) {
		return { items: [], dirs: new Map() }
	}

	return { items: itemsOf(listing), dirs: new Map(listing.linkedDirs.map(dir => [dir.inner.uuid, dir])) }
}
