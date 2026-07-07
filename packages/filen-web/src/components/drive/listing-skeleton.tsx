import { type DriveViewMode } from "@/lib/drive/preferences"
import { Skeleton } from "@/components/ui/skeleton"

export interface ListingSkeletonProps {
	viewMode: DriveViewMode
}

const LIST_ROW_COUNT = 8
const GRID_TILE_COUNT = 12

export function ListingSkeleton({ viewMode }: ListingSkeletonProps) {
	if (viewMode === "grid") {
		return (
			<div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-4 p-4">
				{Array.from({ length: GRID_TILE_COUNT }, (_, index) => (
					<Skeleton
						key={index}
						className="aspect-square rounded-2xl"
					/>
				))}
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-1 p-4">
			{Array.from({ length: LIST_ROW_COUNT }, (_, index) => (
				<Skeleton
					key={index}
					className="h-10 w-full rounded-xl"
				/>
			))}
		</div>
	)
}
