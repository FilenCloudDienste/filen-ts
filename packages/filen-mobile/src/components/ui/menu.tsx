import { memo, useCallback, useMemo } from "@/lib/memo"
import { withUniwind, useResolveClassNames } from "uniwind"
import { type StyleProp, type ViewStyle, Platform } from "react-native"
import { MenuView, type NativeActionEvent, type MenuAction } from "@react-native-menu/menu"
import {
	ContextMenuView,
	ContextMenuButton,
	type MenuConfig,
	type MenuAttributes,
	type MenuElementConfig,
	type OnPressMenuItemEventObject,
	type MenuElementSize,
	type MenuPreviewConfig
} from "react-native-ios-context-menu"
import { Image as SwiftUiImage } from "@expo/ui/swift-ui"

export type MenuButton = {
	onPress?: () => void
	id: string
	subButtons?: MenuButton[]
	subButtonsInline?: boolean
	checked?: boolean
	loading?: boolean
	subTitle?: string
	destructive?: boolean
	hidden?: boolean
	disabled?: boolean
	icon?: Icons
	title?: string
	keepMenuOpenOnPress?: boolean
	titleColor?: string
	iconColor?: string
	testID?: string
	iOSItemSize?: MenuElementSize
}

export type Icons =
	| "heart"
	| "pin"
	| "trash"
	| "edit"
	| "delete"
	| "duplicate"
	| "copy"
	| "export"
	| "archive"
	| "clock"
	| "select"
	| "user"
	| "users"
	| "tag"
	| "restore"
	| "exit"
	| "plus"
	| "plusCircle"
	| "plusSquare"
	| "text"
	| "richtext"
	| "markdown"
	| "code"
	| "checklist"
	| "search"
	| "eye"
	| "list"
	| "grid"

function iconToSwiftUiIcon(name: Icons, fill?: boolean): React.ComponentPropsWithoutRef<typeof SwiftUiImage>["systemName"] {
	switch (name) {
		case "heart": {
			return fill ? "heart.fill" : "heart"
		}

		case "pin": {
			return fill ? "pin.fill" : "pin"
		}

		case "trash": {
			return fill ? "trash.fill" : "trash"
		}

		case "edit": {
			return fill ? "pencil" : "pencil"
		}

		case "delete": {
			return fill ? "xmark.circle.fill" : "xmark.circle"
		}

		case "duplicate": {
			return fill ? "doc.on.doc.fill" : "doc.on.doc"
		}

		case "copy": {
			return fill ? "doc.on.clipboard.fill" : "doc.on.clipboard"
		}

		case "export": {
			return fill ? "square.and.arrow.up.fill" : "square.and.arrow.up"
		}

		case "archive": {
			return fill ? "archivebox.fill" : "archivebox"
		}

		case "clock": {
			return fill ? "clock.fill" : "clock"
		}

		case "select": {
			return fill ? "checkmark.circle.fill" : "checkmark.circle"
		}

		case "user": {
			return fill ? "person.fill" : "person"
		}

		case "users": {
			return fill ? "person.2.fill" : "person.2"
		}

		case "tag": {
			return fill ? "tag.fill" : "tag"
		}

		case "restore": {
			return fill ? "arrow.uturn.left" : "arrow.uturn.left"
		}

		case "exit": {
			return fill ? "escape" : "escape"
		}

		case "plus": {
			return fill ? "plus" : "plus"
		}

		case "plusCircle": {
			return fill ? "plus.circle.fill" : "plus.circle"
		}

		case "plusSquare": {
			return fill ? "plus.rectangle.fill" : "plus.rectangle"
		}

		case "text": {
			return fill ? "textformat" : "textformat"
		}

		case "richtext": {
			return fill ? "doc.plaintext.fill" : "doc.plaintext"
		}

		case "markdown": {
			return fill ? "arrow.down.doc.fill" : "arrow.down.doc"
		}

		case "code": {
			return fill ? "chevron.left.slash.chevron.right" : "chevron.left.slash.chevron.right"
		}

		case "checklist": {
			return fill ? "checklist.checked" : "checklist"
		}

		case "search": {
			return fill ? "magnifyingglass" : "magnifyingglass"
		}

		case "eye": {
			return fill ? "eye.fill" : "eye"
		}

		case "list": {
			return fill ? "list.bullet.rectangle.fill" : "list.bullet.rectangle"
		}

		case "grid": {
			return fill ? "square.grid.2x2.fill" : "square.grid.2x2"
		}
	}
}

function findButtonById(buttons: MenuButton[], id: string): MenuButton | null {
	if (!buttons) {
		return null
	}

	for (const button of buttons) {
		if (button.id === id) {
			return button
		}

		if (button.subButtons) {
			const found = findButtonById(button.subButtons, id)

			if (found) {
				return found
			}
		}
	}

	return null
}

function checkIfButtonIdsAreUnique(buttons: MenuButton[]): boolean {
	const ids = new Set<string>()

	function checkButtons(buttonsToCheck: MenuButton[]): boolean {
		for (const button of buttonsToCheck) {
			if (ids.has(button.id)) {
				return false
			}

			ids.add(button.id)

			if (button.subButtons) {
				const unique = checkButtons(button.subButtons)

				if (!unique) {
					return false
				}
			}
		}

		return true
	}

	return checkButtons(buttons)
}

function toReactNativeMenuActions({
	buttons,
	colors
}: {
	buttons: MenuButton[]
	colors: {
		normal: string
		destructive: string
		disabled: string
	}
}): MenuAction[] {
	return buttons.map(button => {
		const iosIcon = button.icon ? iconToSwiftUiIcon(button.icon) : undefined

		return {
			subactions:
				button.subButtons && button.subButtons.length > 0
					? toReactNativeMenuActions({
							buttons: button.subButtons,
							colors
						})
					: undefined,
			id: button.id,
			title: button.title ?? "",
			state: button.checked ? "on" : undefined,
			subtitle: button.subTitle,
			titleColor: button.titleColor,
			imageColor: button.iconColor,
			displayInline: button.subButtonsInline,
			...(iosIcon
				? {
						image: iosIcon,
						imageColor: button.destructive ? colors.destructive : button.disabled ? colors.disabled : colors.normal
					}
				: {}),
			attributes: {
				destructive: button.destructive,
				disabled: button.disabled,
				keepsMenuPresented: button.keepMenuOpenOnPress,
				hidden: button.hidden
			}
		} satisfies MenuAction
	})
}

function iosMenuAttributesFromButton(button: MenuButton): MenuAttributes[] {
	const attributes: MenuAttributes[] = []

	if (button.destructive) {
		attributes.push("destructive")
	}

	if (button.disabled) {
		attributes.push("disabled")
	}

	if (button.hidden) {
		attributes.push("hidden")
	}

	if (button.keepMenuOpenOnPress) {
		attributes.push("keepsMenuPresented")
	}

	return attributes
}

function toIosMenuSubMenuConfig(button: MenuButton): MenuElementConfig {
	if (button.loading) {
		return {
			type: "deferred",
			deferredID: `${button.id}-${Date.now()}`
		}
	}

	const attributes = iosMenuAttributesFromButton(button)
	const iosIcon = button.icon ? iconToSwiftUiIcon(button.icon) : undefined

	return {
		menuOptions: button.subButtonsInline ? ["displayInline"] : undefined,
		menuTitle: button.title ?? "",
		menuSubtitle: button.subTitle,
		menuPreferredElementSize: button.iOSItemSize,
		discoverabilityTitle: button.subTitle,
		menuAttributes: attributes.length > 0 ? attributes : undefined,
		icon: iosIcon
			? {
					type: "IMAGE_SYSTEM",
					imageValue: {
						systemName: iosIcon
					}
				}
			: undefined,
		menuState: button.checked ? "on" : undefined,
		menuItems: button.subButtons
			? button.subButtons.map(button => {
					if ("subButtons" in button) {
						return toIosMenuSubMenuConfig(button)
					}

					return toIosMenuElementConfig(button)
				})
			: undefined
	}
}

function toIosMenuElementConfig(button: MenuButton): MenuElementConfig {
	if (button.loading) {
		return {
			type: "deferred",
			deferredID: `${button.id}-${Date.now()}`
		}
	}

	const attributes = iosMenuAttributesFromButton(button)
	const iosIcon = button.icon ? iconToSwiftUiIcon(button.icon) : undefined

	return {
		actionKey: button.id,
		actionTitle: button.title ?? "",
		actionSubtitle: button.subTitle,
		discoverabilityTitle: button.subTitle,
		menuAttributes: attributes.length > 0 ? attributes : undefined,
		icon: iosIcon
			? {
					type: "IMAGE_SYSTEM",
					imageValue: {
						systemName: iosIcon
					}
				}
			: undefined,
		menuState: button.checked ? "on" : undefined
	} satisfies MenuElementConfig
}

function toIosMenuConfig({
	buttons,
	title,
	iOSItemSize
}: {
	buttons: MenuButton[]
	title?: string
	iOSItemSize?: MenuElementSize
}): MenuConfig {
	return {
		menuTitle: title ?? "",
		menuPreferredElementSize: iOSItemSize,
		menuItems:
			buttons.length > 0
				? buttons.map(button => {
						if ("subButtons" in button) {
							return toIosMenuSubMenuConfig(button)
						}

						return toIosMenuElementConfig(button)
					})
				: undefined
	} satisfies MenuConfig
}

export const MenuInner = memo(
	({
		buttons,
		type,
		children,
		title,
		disabled,
		style,
		isAnchoredToRight,
		onOpenMenu,
		onCloseMenu,
		testID,
		renderPreview,
		hitSlop,
		previewConfig
	}: {
		children: React.ReactNode
		type?: "dropdown" | "context"
		style?: StyleProp<ViewStyle>
		title?: string
		buttons?: MenuButton[]
		className?: string
		disabled?: boolean
		onOpenMenu?: () => void
		onCloseMenu?: () => void
		isAnchoredToRight?: boolean
		testID?: string
		renderPreview?: () => React.ReactElement
		hitSlop?:
			| number
			| {
					top?: number
					bottom?: number
					left?: number
					right?: number
			  }
		previewConfig?: MenuPreviewConfig
	}) => {
		const textForeground = useResolveClassNames("text-foreground")
		const textRed500 = useResolveClassNames("text-red-500")
		const textMutedForeground = useResolveClassNames("text-muted-foreground")

		const uniqueButtons = useMemo(() => {
			if (!buttons) {
				return []
			}

			if (!checkIfButtonIdsAreUnique(buttons)) {
				throw new Error("Menu button IDs must be unique")
			}

			return buttons
		}, [buttons])

		const onPressAction = useCallback(
			(e: NativeActionEvent) => {
				const button = findButtonById(uniqueButtons, e.nativeEvent.event)

				if (!button) {
					return
				}

				button?.onPress?.()
			},
			[uniqueButtons]
		)

		const onPressMenuItem = useCallback(
			(e: OnPressMenuItemEventObject) => {
				const button = findButtonById(uniqueButtons, e.nativeEvent.actionKey)

				if (!button) {
					return
				}

				button?.onPress?.()
			},
			[uniqueButtons]
		)

		const { menuConfig, actions } = useMemo(() => {
			return {
				menuConfig: toIosMenuConfig({
					buttons: uniqueButtons,
					title
				}),
				actions: toReactNativeMenuActions({
					buttons: uniqueButtons,
					colors: {
						normal: (textForeground.color as string) ?? "white",
						destructive: (textRed500.color as string) ?? "white",
						disabled: (textMutedForeground.color as string) ?? "white"
					}
				})
			}
		}, [uniqueButtons, textForeground.color, textRed500.color, textMutedForeground.color, title])

		if (disabled) {
			return children
		}

		if (Platform.OS === "ios") {
			if (type === "dropdown") {
				return (
					<ContextMenuButton
						hitSlop={hitSlop}
						style={style}
						testID={testID}
						onMenuWillShow={onOpenMenu}
						onMenuWillHide={onCloseMenu}
						onPressMenuItem={onPressMenuItem}
						menuConfig={menuConfig}
					>
						{children}
					</ContextMenuButton>
				)
			}

			return (
				<ContextMenuView
					hitSlop={hitSlop}
					style={style}
					testID={testID}
					onMenuWillShow={onOpenMenu}
					onMenuWillHide={onCloseMenu}
					renderPreview={renderPreview}
					lazyPreview={!!renderPreview}
					previewConfig={
						renderPreview && !previewConfig
							? {
									previewSize: "INHERIT",
									preferredCommitStyle: "dismiss",
									isResizeAnimated: true,
									previewType: "CUSTOM"
								}
							: previewConfig
					}
					onPressMenuItem={onPressMenuItem}
					shouldWaitForMenuToHideBeforeFiringOnPressMenuItem={false}
					menuConfig={menuConfig}
				>
					{children}
				</ContextMenuView>
			)
		}

		return (
			<MenuView
				shouldOpenOnLongPress={type === "context"}
				actions={actions}
				onPressAction={onPressAction}
				style={style}
				isAnchoredToRight={isAnchoredToRight}
				onOpenMenu={onOpenMenu}
				onCloseMenu={onCloseMenu}
				title={title}
				testID={testID}
				hitSlop={
					typeof hitSlop === "number"
						? {
								top: hitSlop,
								bottom: hitSlop,
								left: hitSlop,
								right: hitSlop
							}
						: {
								top: hitSlop?.top ?? 0,
								bottom: hitSlop?.bottom ?? 0,
								left: hitSlop?.left ?? 0,
								right: hitSlop?.right ?? 0
							}
				}
			>
				{children}
			</MenuView>
		)
	}
)

export const Menu = withUniwind(MenuInner) as typeof MenuInner

export default Menu
