import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { ListSkeleton } from "@/components/listSkeleton"

export interface ListingSkeletonProps {
	viewMode: DriveViewMode
}

const LIST_ROW_COUNT = 8
const GRID_TILE_COUNT = 12

// Both branches delegate to the announcing primitive, so the role="status" lives in exactly one place
// for every consumer (drive's grid and list views, the search-warming state, photos, and the four
// directory-picker dialogs).
export function ListingSkeleton({ viewMode }: ListingSkeletonProps) {
	if (viewMode === "grid") {
		return (
			<ListSkeleton
				count={GRID_TILE_COUNT}
				itemClassName="aspect-square rounded-2xl"
				className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-4 p-4"
			/>
		)
	}

	return (
		<ListSkeleton
			count={LIST_ROW_COUNT}
			itemClassName="h-10 w-full rounded-xl"
			className="flex flex-col gap-1 p-4"
		/>
	)
}
