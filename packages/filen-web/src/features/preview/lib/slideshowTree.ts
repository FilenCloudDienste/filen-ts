import type { AnyLinkedDir, Dir, DirPublicLink, File } from "@filen/sdk-rs"
import { driveItemName, isHiddenName, isRootDotFilen } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"

// A slideshow's "include subdirectories" list: every slideable file below one directory, in directory path then
// natural name order. The worker returns slideable files only, so this never sees the rest of the tree.

// `hideDotFiles` and `dotFilenRoot` are the opening listing's own rules (`dotFilenRoot` is the drive root uuid
// while the root `.filen` is hidden, else null); a public link never hides.
export type SlideshowSource =
	| { kind: "owned"; uuid: string; hideDotFiles: boolean; dotFilenRoot: string | null }
	| { kind: "shared"; variant: "sharedIn" | "sharedOut"; uuid: string; path: readonly string[]; hideDotFiles: boolean }
	| { kind: "linked"; dir: AnyLinkedDir; link: DirPublicLink }

interface TreeListing {
	dirs: readonly Dir[]
	files: readonly File[]
	narrow: (file: File) => DriveItem
}

// A directory's place in the tree: its ancestry's names from the listed root down, and whether that ancestry hides it.
interface DirPlace {
	segments: readonly string[]
	hidden: boolean
}

const ROOT_PLACE: DirPlace = { segments: [], hidden: false }

const collator = new Intl.Collator(undefined, { numeric: true })

async function listTree(source: SlideshowSource): Promise<TreeListing> {
	switch (source.kind) {
		case "owned": {
			const { dirs, files } = await sdkApi.listSlideshowOwned(source.uuid)

			return { dirs, files, narrow: narrowItem }
		}
		case "shared": {
			const { dirs, files, role } = await sdkApi.listSlideshowShared(source.uuid, { variant: source.variant, path: [...source.path] })

			return { dirs: dirs.map(dir => dir.inner), files, narrow: file => narrowItem({ ...file, sharingRole: role }) }
		}
		case "linked": {
			const { dirs, files } = await sdkApi.listSlideshowLinked(source.dir, source.link)

			return { dirs: dirs.map(dir => dir.inner), files, narrow: narrowItem }
		}
	}
}

function dirName(dir: Dir): string {
	return dir.meta.type === "decoded" ? dir.meta.data.name : dir.uuid
}

function compareSegments(a: readonly string[], b: readonly string[]): number {
	const length = Math.min(a.length, b.length)

	for (let i = 0; i < length; i++) {
		const order = collator.compare(a[i] ?? "", b[i] ?? "")

		if (order !== 0) {
			return order
		}
	}

	return a.length - b.length
}

// An abort resolves to an empty list, so a superseded fetch never lands.
export async function fetchSlideshowTree(source: SlideshowSource, signal: AbortSignal): Promise<DriveItem[]> {
	const listing = signal.aborted ? null : await listTree(source)

	if (listing === null || signal.aborted) {
		return []
	}

	const { dirs, files, narrow } = listing

	const hideDotFiles = source.kind !== "linked" && source.hideDotFiles
	// Only an owned walk can reach the root `.filen`.
	const rootUuid = source.kind === "owned" ? source.dotFilenRoot : null
	const dirByUuid = new Map<string, Dir>()

	for (const dir of dirs) {
		dirByUuid.set(dir.uuid, dir)
	}

	const places = new Map<string, DirPlace>()

	// Ancestry first; a parent outside the listing is the listed root.
	const placeOf = (uuid: string): DirPlace => {
		const known = places.get(uuid)

		if (known !== undefined) {
			return known
		}

		const dir = dirByUuid.get(uuid)

		if (dir === undefined) {
			return ROOT_PLACE
		}

		const parent = placeOf(dir.parent)
		const name = dirName(dir)
		const place: DirPlace = {
			segments: [...parent.segments, name],
			hidden: parent.hidden || (hideDotFiles && isHiddenName(name)) || isRootDotFilen({ name, parentUuid: dir.parent, rootUuid })
		}

		places.set(uuid, place)

		return place
	}

	const kept: { item: DriveItem; place: DirPlace; name: string }[] = []

	for (const file of files) {
		const place = placeOf(file.parent)

		if (place.hidden) {
			continue
		}

		const item = narrow(file)
		const name = driveItemName(item)

		if (hideDotFiles && isHiddenName(name)) {
			continue
		}

		kept.push({ item, place, name })
	}

	// Each directory is ranked once, so the file sort compares a number before a name.
	const ordered = [...new Set(kept.map(entry => entry.place))].sort((a, b) => compareSegments(a.segments, b.segments))
	const rank = new Map<DirPlace, number>(ordered.map((place, index) => [place, index]))

	kept.sort((a, b) => (rank.get(a.place) ?? 0) - (rank.get(b.place) ?? 0) || collator.compare(a.name, b.name))

	return kept.map(entry => entry.item)
}
