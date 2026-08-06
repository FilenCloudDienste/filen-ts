import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import { type DriveItem } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { Checkbox } from "@/components/ui/checkbox"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import Menu from "@/features/drive/components/item/menu"
import HighlightOverlay from "@/features/drive/components/item/highlightOverlay"
import { FavoritedIndicatorCard, OfflineIndicatorCard } from "@/features/drive/components/item/indicators"
import useDriveItemInteraction from "@/features/drive/hooks/useDriveItemInteraction"
import useDriveItemIndicators from "@/features/drive/hooks/useDriveItemIndicators"
import { driveItemDisplayName } from "@/lib/decryption"
import { driveScreenUsesBaseBackground } from "@/features/drive/driveSelectors"
import { GRID_CELL_PADDING } from "@/features/drive/driveGrid"
import { cn } from "@filen/utils"

// Per-cell padding on all sides (the gap between adjacent cells = 2× this). Sourced from driveGrid
// so the grid's screen-edge inset and inter-item gutter stay in sync.
const CELL_PADDING = GRID_CELL_PADDING

export default function GridItem({
	info,
	drivePath,
	getListItems,
	itemWidth,
	highlighted
}: {
	info: ListRenderItemInfo<DriveItem>
	drivePath: DrivePath
	getListItems: () => DriveItem[]
	itemWidth: number
	// True for the single cell "open containing directory" navigated here to reveal, for as long as
	// its tint plays out.
	highlighted?: boolean
}) {
	const { onPress, disabled, navigateOnly, isSelected, isSelecting, isSelectedFromDriveSelect, onPressSelectForDriveSelect } =
		useDriveItemInteraction({ info, drivePath, getListItems })
	const { showFavorited, showOffline, isStoredOffline, hasSyncError } = useDriveItemIndicators({
		item: info.item,
		drivePath
	})

	const cardSize = itemWidth - CELL_PADDING * 2

	// Differentiate the two selection modes so the checkbox wires the correct handler,
	// matching the list row's per-mode Checkbox wiring exactly.
	const isPickerSelect = drivePath.selectOptions?.intention === "select"

	// In picker (driveSelect) mode the disabled gate must suppress both the value and the
	// handler, with a transparent checkbox colour to signal unavailability — same as the row.
	const checkboxValue = isPickerSelect ? (disabled ? false : isSelectedFromDriveSelect) : isSelected
	const checkboxOnChange = isPickerSelect ? (disabled ? undefined : onPressSelectForDriveSelect) : onPress

	return (
		<View
			className={cn("bg-transparent items-center", disabled && !navigateOnly && "opacity-50")}
			style={{ width: itemWidth, padding: CELL_PADDING }}
		>
			{/*
			 * Menu OUTSIDE the PressableScale (project rule: Menu wrapper must sit outside
			 * gesture-handler pressables). type="context" → long-press on both platforms;
			 * no per-cell ellipsis trigger needed. Disabled in driveSelect picker mode to
			 * match the list row behaviour.
			 */}
			<Menu
				type="context"
				isAnchoredToRight={true}
				previewBackground={true}
				disabled={!!drivePath.selectOptions}
				item={info.item}
				drivePath={drivePath}
				isStoredOffline={isStoredOffline}
			>
				<PressableScale
					className="bg-transparent items-center w-full rounded-3xl"
					onPress={onPress}
					// The card below is opaque, so Android's background-layer ripple would be hidden behind
					// it — only leaking through the corner cut-outs and the label strip (see pressables.tsx).
					foreground={true}
				>
					{/*
					 * Square card — fills with the thumbnail image/video (contentFit="cover") for
					 * media items; for directories/unknown files the icon renders centred at half
					 * the card size via the `icon` slot, so it doesn't stretch.
					 */}
					<View
						className={cn(
							"rounded-3xl items-center justify-center overflow-hidden",
							driveScreenUsesBaseBackground(drivePath) ? "bg-background-secondary" : "bg-background-tertiary"
						)}
						style={{ width: cardSize, height: cardSize }}
					>
						<Thumbnail
							item={info.item}
							target={info.target}
							size={{ icon: Math.round(cardSize * 0.5), thumbnail: cardSize }}
							contentFit="cover"
						/>
						{/* Over the thumbnail (which fills the card, so a tint behind it would be
						    invisible) but under the badges. The card clips it to its own rounding. */}
						{highlighted && <HighlightOverlay />}
						{showOffline && <OfflineIndicatorCard />}
						{showFavorited && <FavoritedIndicatorCard />}
						{isSelecting && (
							<View className="absolute top-1.5 right-1.5 bg-transparent">
								<Checkbox
									value={checkboxValue}
									onValueChange={checkboxOnChange}
									hitSlop={12}
									color={isPickerSelect && disabled ? "transparent" : undefined}
								/>
							</View>
						)}
					</View>
					{/* Filename: full-width centered single line (offline/favorite badges live on the card
					    above, like the photos grid, so nothing offsets the text). A red name flags an
					    offline sync error in the /offline view. */}
					<Text
						className={cn("text-sm text-center px-1 pt-1.5 flex-1", hasSyncError ? "text-red-500" : "text-foreground")}
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{driveItemDisplayName(info.item)}
					</Text>
				</PressableScale>
			</Menu>
		</View>
	)
}
