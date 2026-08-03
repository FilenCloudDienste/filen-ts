import { useTranslation } from "react-i18next"
import { Skeleton } from "@/components/ui/skeleton"

export interface ListSkeletonProps {
	count: number
	itemClassName: string
	className: string
}

// N placeholder bars/tiles in the shape of the list they stand in for. The role="status" wrapper is the
// whole announcement — the bars themselves say nothing — so a screen reader hears "Loading" once
// instead of nothing (a bare skeleton has no role, unlike the Spinner these replace). Never nest one
// inside another: two labelled live regions announce twice.
export function ListSkeleton({ count, itemClassName, className }: ListSkeletonProps) {
	const { t } = useTranslation("common")

	return (
		<div
			role="status"
			aria-label={t("loading")}
			className={className}
		>
			{Array.from({ length: count }, (_, index) => (
				<Skeleton
					key={index}
					className={itemClassName}
				/>
			))}
		</div>
	)
}
