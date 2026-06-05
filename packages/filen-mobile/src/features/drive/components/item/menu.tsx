import { memo } from "react"
import MenuComponent from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { type StyleProp, type ViewStyle } from "react-native"
import type { DrivePath } from "@/hooks/useDrivePath"
import { useTranslation } from "react-i18next"
import { createMenuButtons } from "@/features/drive/components/item/menuActions"

const Menu = memo(
	({
		item,
		children,
		type,
		className,
		isAnchoredToRight,
		onOpenMenu,
		onCloseMenu,
		drivePath,
		isStoredOffline,
		disabled,
		style,
		showSelectToggle
	}: {
		item: DriveItem
		children: React.ReactNode
		type: React.ComponentPropsWithoutRef<typeof MenuComponent>["type"]
		className?: string
		isAnchoredToRight?: boolean
		onOpenMenu?: () => void
		onCloseMenu?: () => void
		drivePath: DrivePath
		isStoredOffline: boolean
		disabled?: boolean
		style?: StyleProp<ViewStyle>
		showSelectToggle?: boolean
	}) => {
		const { t } = useTranslation()
		const menuButtons = disabled
			? []
			: createMenuButtons({
					item,
					drivePath,
					isStoredOffline,
					showSelectToggle,
					t
				})

		return (
			<MenuComponent
				className={className}
				type={type}
				isAnchoredToRight={isAnchoredToRight}
				buttons={menuButtons}
				title={item.data.decryptedMeta?.name}
				onCloseMenu={onCloseMenu}
				onOpenMenu={onOpenMenu}
				disabled={disabled}
				style={style}
			>
				{children}
			</MenuComponent>
		)
	}
)

export default Menu
