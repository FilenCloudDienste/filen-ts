import MenuComponent from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { type StyleProp, type ViewStyle } from "react-native"
import type { DrivePath } from "@/hooks/useDrivePath"
import { useTranslation } from "react-i18next"
import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"
import { offersPasteInto } from "@/features/drive/components/clipboardMenu"
import useLinkSaveable from "@/features/drive/hooks/useLinkSaveable"
import { linkSaveTarget } from "@/features/drive/linkedSave"

type MenuProps = {
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
	// Set by the preview (gallery) header so destructive actions close the preview on success.
	isPreview?: boolean
	previewBackground?: boolean
}

const MenuInner = ({
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
	showSelectToggle,
	isPreview,
	previewBackground,
	linkSaveable
}: MenuProps & { linkSaveable?: boolean }) => {
	const { t } = useTranslation()
	// Only rows offering "Paste into" re-render when the clipboard changes.
	const followsClipboard = !disabled && offersPasteInto(drivePath, item)
	const clipboard = useDriveClipboardStore(state => (followsClipboard ? state.entry : null))
	const menuButtons = disabled
		? []
		: createMenuButtons({
				item,
				drivePath,
				isStoredOffline,
				showSelectToggle,
				isPreview,
				clipboard,
				linkSaveable,
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
			previewBackground={previewBackground}
		>
			{children}
		</MenuComponent>
	)
}

// Only link views ask whether the link may be saved, so rows elsewhere pay for no query observer.
const LinkedMenu = (props: MenuProps) => {
	const linkSaveable = useLinkSaveable(props.disabled ? null : linkSaveTarget(props.drivePath, props.item))

	return (
		<MenuInner
			{...props}
			linkSaveable={linkSaveable}
		/>
	)
}

const Menu = (props: MenuProps) => {
	return props.drivePath.type === "linked" ? <LinkedMenu {...props} /> : <MenuInner {...props} />
}

export default Menu
