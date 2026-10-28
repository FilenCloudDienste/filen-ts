import { listRest, OUTSIDE_DATES_ITEMS } from "@filen/shared/assistant"
import { storageSummary } from "@filen/shared"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY, ACCOUNT_STALE_TIME, fetchAccount } from "@/queries/account"
import { previewType } from "@/features/drive/lib/preview.logic"
import { mergePhotosListings, photosListingQueryOptions } from "@/features/photos/queries/photos"
import { photosLibraryRoots } from "@/features/photos/lib/library"
import { resolveOutermostRoots } from "@/lib/directoryRoots"
import { captureTimestamp } from "@/features/photos/lib/captureSort"
import {
	cachedDriveRows,
	driveKind,
	driveName,
	optionalString,
	readUnsyncedListing,
	showDrive,
	type ToolAdapter
} from "@/features/assistant/tools/entities"
import { AssistantToolError, isoDate, throwIfStopped } from "@/features/assistant/tools/format"
import { dateSelection, datesField, emptyDatesNote, selects } from "@/features/assistant/tools/dates"
import {
	directorySizes,
	inDriveSelection,
	joinNotes,
	listingFields,
	matchesKind,
	sortListing,
	unknownSizesNote,
	type ListingSort
} from "@/features/assistant/tools/drive"

const RECENT_LIMIT = 20
const PHOTOS_LIMIT = 30

// The Recents screen's own listing and query. Its rows carry no location, so a path comes from the My Drive
// listings already cached, when they hold the item's ancestors.
export const recentItemsTool: ToolAdapter = async (input, scope) => {
	const selection = dateSelection(input, ["uploaded", "modified"], scope.calendar)
	const kind = optionalString(input, "kind")
	// The loop validated it against the enum.
	const sort = (optionalString(input, "sort") ?? "newest") as ListingSort
	const bySize = sort === "largest" || sort === "smallest"
	const recents = (await readUnsyncedListing("recents")).filter(item => !item.data.undecryptable)

	throwIfStopped(scope)

	const ofKind = recents.filter(item => matchesKind(item, kind))
	const kept = ofKind.filter(item => inDriveSelection(item, selection))
	const sizes = bySize ? await directorySizes(kept) : { sizes: new Map<string, number>(), unknown: 0 }

	throwIfStopped(scope)

	const items = sortListing(kept, sort, selection.field, sizes.sizes)
	const shown = items.slice(0, RECENT_LIMIT)
	// The latest files, when the dates left none (OUTSIDE_DATES_ITEMS).
	const newest =
		selection.range !== null && items.length === 0 && sort === "newest"
			? sortListing(ofKind, "newest", selection.field).slice(0, OUTSIDE_DATES_ITEMS)
			: []
	const wanted = new Set([...shown, ...newest].map(item => item.data.uuid))
	const paths = new Map<string, string | undefined>()

	if (wanted.size > 0) {
		for (const { item, path } of cachedDriveRows(row => wanted.has(row.data.uuid))) {
			paths.set(item.data.uuid, path)
		}
	}

	// Recents ages files out by upload time over a window the app is not told, so a period starting before its
	// oldest upload may or may not be complete: said as what the list holds, never as files missing from it.
	const oldest = recents.reduce((min, item) => Math.min(min, Number(item.data.timestamp)), Infinity)
	const reach =
		selection.bounds !== null && recents.length > 0 && selection.bounds.start < oldest
			? { note: `Recents reaches back to uploads of ${isoDate(oldest)}; a file uploaded earlier would not be listed here.` }
			: {}

	const row = (item: (typeof recents)[number]) => {
		const path = paths.get(item.data.uuid)

		return {
			handle: showDrive(scope, item, path),
			name: driveName(item),
			kind: driveKind(item),
			...(path === undefined ? {} : { path }),
			...listingFields(item, { date: selection.field, size: bySize, directorySizes: sizes.sizes })
		}
	}

	return {
		value: {
			items: shown.map(row),
			...(newest.length === 0 ? {} : { newest: newest.map(row) }),
			...listRest(items.length, RECENT_LIMIT),
			...datesField(selection),
			...joinNotes(emptyDatesNote(selection, items.length, ofKind.length), reach, unknownSizesNote(sizes.unknown))
		}
	}
}

// The Photos timeline's own listing, by the date it shows (captureTimestamp). A listing the grid already holds
// is reused unless an event marked it stale; otherwise this is the walk opening Photos would run.
export const listPhotosTool: ToolAdapter = async (input, scope) => {
	const selection = dateSelection(input, ["taken"], scope.calendar)
	const kind = optionalString(input, "kind") ?? "any"
	const oldestFirst = optionalString(input, "sort") === "oldest"
	const roots = await photosLibraryRoots()

	if (roots.length === 0) {
		throw new AssistantToolError("Photos has no directory set up yet; the user chooses one on the Photos screen")
	}

	// The roots the grid lists, each listing walked only when the grid doesn't hold it already.
	const listed = await resolveOutermostRoots(roots)
	const { photos } = mergePhotosListings(
		await Promise.all(listed.map(root => queryClient.query({ ...photosListingQueryOptions(root), staleTime: Infinity })))
	)

	throwIfStopped(scope)

	const ofKind = photos.filter(photo => kind === "any" || (previewType(photo) === "video") === (kind === "video"))
	const kept = ofKind.filter(photo => selects(selection, captureTimestamp(photo)))
	// The listing is newest first.
	const ordered = oldestFirst ? kept.toReversed() : kept

	return {
		value: {
			photos: ordered.slice(0, PHOTOS_LIMIT).map(photo => ({
				handle: showDrive(scope, photo, undefined),
				name: driveName(photo),
				taken: isoDate(captureTimestamp(photo))
			})),
			...listRest(ordered.length, PHOTOS_LIMIT),
			...datesField(selection),
			...emptyDatesNote(selection, kept.length, ofKind.length)
		}
	}
}

// The figures the storage meter shows, from the account the app already holds; read again only once the
// account query itself would be (a write marked it stale, or its stale time passed).
export const getStorageTool: ToolAdapter = async () => {
	const account = await queryClient.query({ queryKey: ACCOUNT_QUERY_KEY, queryFn: fetchAccount, staleTime: ACCOUNT_STALE_TIME })

	return { value: storageSummary(account) }
}
