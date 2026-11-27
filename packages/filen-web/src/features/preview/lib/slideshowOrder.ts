import type { Dir, File } from "@filen/sdk-rs"
import { driveItemName, isHiddenName, isRootDotFilen } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// A slideshow's "include subdirectories" order: the files `keep` admits below one directory, in directory path then
// natural name order, without what the opening listing hides. Run in the SDK worker beside the listing, so a tree of
// a hundred thousand photos is sorted off the main thread and only its slides cross.

// The opening listing's own rules: `hideDotFiles`, and `dotFilenRoot` (the drive root uuid while the root `.filen` is
// hidden, else null). A public link hides nothing.
export interface SlideshowOrderRules {
	hideDotFiles: boolean
	dotFilenRoot: string | null
}

export const NO_HIDING: SlideshowOrderRules = { hideDotFiles: false, dotFilenRoot: null }

// A directory's place in the tree: its ancestry's names from the listed root down, and whether that ancestry hides it.
interface DirPlace {
	segments: readonly string[]
	hidden: boolean
}

const ROOT_PLACE: DirPlace = { segments: [], hidden: false }

const collator = new Intl.Collator(undefined, { numeric: true })

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

export function orderSlideshowFiles(
	dirs: readonly Dir[],
	files: readonly File[],
	rules: SlideshowOrderRules,
	keep: (item: DriveItem) => boolean
): File[] {
	const { hideDotFiles, dotFilenRoot } = rules
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
			hidden:
				parent.hidden ||
				(hideDotFiles && isHiddenName(name)) ||
				isRootDotFilen({ name, parentUuid: dir.parent, rootUuid: dotFilenRoot })
		}

		places.set(uuid, place)

		return place
	}

	const kept: { file: File; place: DirPlace; name: string; rank: number }[] = []

	for (const file of files) {
		const place = placeOf(file.parent)

		if (place.hidden) {
			continue
		}

		const item = narrowItem(file)

		if (!keep(item)) {
			continue
		}

		const name = driveItemName(item)

		if (hideDotFiles && isHiddenName(name)) {
			continue
		}

		kept.push({ file, place, name, rank: 0 })
	}

	// Each directory is ranked once, so the file sort compares a number before a name.
	const ordered = [...new Set(kept.map(entry => entry.place))].sort((a, b) => compareSegments(a.segments, b.segments))
	const rank = new Map<DirPlace, number>(ordered.map((place, index) => [place, index]))

	for (const entry of kept) {
		entry.rank = rank.get(entry.place) ?? 0
	}

	kept.sort((a, b) => a.rank - b.rank || collator.compare(a.name, b.name))

	return kept.map(entry => entry.file)
}
