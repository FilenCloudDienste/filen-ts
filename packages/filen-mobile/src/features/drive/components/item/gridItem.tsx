import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import { type DriveItem } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { Checkbox } from "@/components/ui/checkbox"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import Menu from "@/features/drive/components/item/menu"
import { FavoritedIndicatorInline, OfflineIndicatorInline } from "@/features/drive/components/item/indicators"
import useDriveItemInteraction from "@/features/drive/hooks/useDriveItemInteraction"
import useDriveItemIndicators from "@/features/drive/hooks/useDriveItemIndicators"
import { driveItemDisplayName } from "@/lib/decryption"
import { cn } from "@filen/utils"

// Padding around each card on all sides — defines the gutter between cells.
const CELL_PADDING = 6

export default function GridItem({
	info,
	drivePath,
	getListItems,
	itemWidth
}: {
	info: ListRenderItemInfo<DriveItem>
	drivePath: DrivePath
	getListItems: () => DriveItem[]
	itemWidth: number
}) {
	const {
		onPress,
		disabled,
		navigateOnly,
		isSelected,
		isSelecting,
		isSelectedFromDriveSelect,
		onPressSelectForDriveSelect
	} = useDriveItemInteraction({ info, drivePath, getListItems })
	const { showFavorited, showOffline, isStoredOffline } = useDriveItemIndicators({
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
	const checkboxOnChange = isPickerSelect
		? disabled
			? undefined
			: onPressSelectForDriveSelect
		: onPress

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
					className="bg-transparent items-center w-full"
					onPress={onPress}
				>
					{/*
					 * Square card — fills with the thumbnail image/video (contentFit="cover") for
					 * media items; for directories/unknown files the icon renders centred at half
					 * the card size via the `icon` slot, so it doesn't stretch.
					 */}
					<View
						className="bg-background-secondary rounded-2xl items-center justify-center overflow-hidden"
						style={{ width: cardSize, height: cardSize }}
					>
						<Thumbnail
							item={info.item}
							target={info.target}
							size={{ icon: Math.round(cardSize * 0.5), thumbnail: cardSize }}
							contentFit="cover"
						/>
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
					{/* Name row: inline offline/favorite badges precede the truncated filename. */}
					<View className="flex-row items-center justify-center gap-1 pt-1.5 w-full bg-transparent px-1">
						{showOffline && <OfflineIndicatorInline />}
						{showFavorited && <FavoritedIndicatorInline />}
						<Text
							className="text-foreground text-sm text-center shrink"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{driveItemDisplayName(info.item)}
						</Text>
					</View>
				</PressableScale>
			</Menu>
		</View>
	)
}
