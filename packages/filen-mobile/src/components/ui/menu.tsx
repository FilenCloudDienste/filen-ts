import { memo } from "react"
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

export type MenuProps = {
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
}

const MenuInnerIos = memo(({ children, ...props }: MenuProps) => {
	const uniqueButtons = props.buttons && checkIfButtonIdsAreUnique(props.buttons) ? props.buttons : []

	const onPressMenuItem = (e: OnPressMenuItemEventObject) => {
		const button = findButtonById(uniqueButtons, e.nativeEvent.actionKey)

		if (!button) {
			return
		}

		button?.onPress?.()
	}

	const menuConfig = toIosMenuConfig({
		buttons: uniqueButtons,
		title: props.title
	})

	if (props.type === "dropdown") {
		return (
			<ContextMenuButton
				hitSlop={props.hitSlop}
				style={props.style}
				testID={props.testID}
				onMenuWillShow={props.onOpenMenu}
				onMenuWillHide={props.onCloseMenu}
				onPressMenuItem={onPressMenuItem}
				menuConfig={menuConfig}
			>
				{children}
			</ContextMenuButton>
		)
	}

	return (
		<ContextMenuView
			hitSlop={props.hitSlop}
			style={props.style}
			testID={props.testID}
			onMenuWillShow={props.onOpenMenu}
			onMenuWillHide={props.onCloseMenu}
			renderPreview={props.renderPreview}
			lazyPreview={!!props.renderPreview}
			previewConfig={
				props.renderPreview && !props.previewConfig
					? {
							previewSize: "INHERIT",
							preferredCommitStyle: "dismiss",
							isResizeAnimated: true,
							previewType: "CUSTOM"
						}
					: props.previewConfig
			}
			onPressMenuItem={onPressMenuItem}
			shouldWaitForMenuToHideBeforeFiringOnPressMenuItem={false}
			shouldEnableAggressiveCleanup={true}
			shouldPreventLongPressGestureFromPropagating={true}
			shouldCleanupOnComponentWillUnmountForAuxPreview={true}
			shouldCleanupOnComponentWillUnmountForMenuPreview={true}
			menuConfig={menuConfig}
		>
			{children}
		</ContextMenuView>
	)
})

const MenuInnerAndroid = memo(({ children, ...props }: MenuProps) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textRed500 = useResolveClassNames("text-red-500")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	const uniqueButtons = props.buttons && checkIfButtonIdsAreUnique(props.buttons) ? props.buttons : []

	const onPressAction = (e: NativeActionEvent) => {
		const button = findButtonById(uniqueButtons, e.nativeEvent.event)

		if (!button) {
			return
		}

		button?.onPress?.()
	}

	const actions = toReactNativeMenuActions({
		buttons: uniqueButtons,
		colors: {
			normal: (textForeground.color as string) ?? "white",
			destructive: (textRed500.color as string) ?? "white",
			disabled: (textMutedForeground.color as string) ?? "white"
		}
	})

	return (
		<MenuView
			shouldOpenOnLongPress={props.type === "context"}
			actions={actions}
			onPressAction={onPressAction}
			style={props.style}
			isAnchoredToRight={props.isAnchoredToRight}
			onOpenMenu={props.onOpenMenu}
			onCloseMenu={props.onCloseMenu}
			title={props.title}
			testID={props.testID}
			hitSlop={
				typeof props.hitSlop === "number"
					? {
							top: props.hitSlop,
							bottom: props.hitSlop,
							left: props.hitSlop,
							right: props.hitSlop
						}
					: {
							top: props.hitSlop?.top ?? 0,
							bottom: props.hitSlop?.bottom ?? 0,
							left: props.hitSlop?.left ?? 0,
							right: props.hitSlop?.right ?? 0
						}
			}
		>
			{children}
		</MenuView>
	)
})

const MenuInner = memo(({ children, ...props }: MenuProps) => {
	if (props.disabled) {
		return children
	}

	if (Platform.OS === "ios") {
		return <MenuInnerIos {...props}>{children}</MenuInnerIos>
	}

	return <MenuInnerAndroid {...props}>{children}</MenuInnerAndroid>
})

export const Menu = memo(withUniwind(MenuInner) as typeof MenuInner)

export default Menu
