import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"

export interface ListingDropSurfaceProps {
	// The directory on screen (null at the root) and its route chain.
	uuid: string | null
	ancestry: readonly string[]
	disabled: boolean
	children: ReactNode
}

// The listing's own space as a drop target for the directory on screen, so a drag that sprang into a
// directory (springLoad.ts) can be let go anywhere in it, as in Finder. What rows and tiles claim never
// reaches it; a drag of items already here is a no-op move and doesn't light it (a copy does).
//
// Its own component so the hover state re-renders this wrapper alone: `children` arrive as elements the
// listing already built, which React skips when only this state changes. The highlight is an overlay on
// the visible surface below the top gap, since the listing's opaque surface would cover it on this div.
export function ListingDropSurface({ uuid, ancestry, disabled, children }: ListingDropSurfaceProps) {
	const { t } = useTranslation("drive")
	const drop = useDriveDropTarget({
		targetUuid: uuid,
		targetAncestry: ancestry,
		routeChain: { parent: undefined },
		targetName: () => (uuid === null ? t("driveMyDrive") : (cachedDirectoryName(uuid) ?? "")),
		disabled
	})
	const highlight = dropHighlightClass(drop)

	return (
		<div
			className="relative flex min-h-0 flex-1 flex-col pt-4"
			onDragEnter={drop.onDragEnter}
			onDragOver={drop.onDragOver}
			onDragLeave={drop.onDragLeave}
			onDrop={drop.onDrop}
		>
			{children}
			{highlight === false ? null : (
				<div
					aria-hidden="true"
					data-testid="listing-drop-highlight"
					className={cn("pointer-events-none absolute inset-x-0 top-4 bottom-0 z-10", highlight)}
				/>
			)}
		</div>
	)
}
