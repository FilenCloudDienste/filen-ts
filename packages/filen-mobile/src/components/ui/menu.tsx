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
import { type Icons, iconToSwiftUiIcon } from "@/components/ui/menuIcons"
import useIsOnline from "@/hooks/useIsOnline"

// Border radius (pt) for the lifted iOS context-menu preview of FLAT rows that opt in via
// `previewBackground`. A "normal" rounded corner — deliberately NOT the large rounded-4xl of
// card rows (notes/chat bubble). Those already lift opaque from their own rounded children, so
// they do not set `previewBackground` and keep their native look.
const LIFT_PREVIEW_BORDER_RADIUS = 14

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
	requiresOnline?: boolean
	icon?: Icons
	title?: string
	keepMenuOpenOnPress?: boolean
	titleColor?: string
	iconColor?: string
	testID?: string
	iOSItemSize?: MenuElementSize
}

// Recursively merges the requiresOnline flag into effective `disabled` for a button
// and its subButtons. Called once per render from MenuInner with the current
// `hasInternet` value.
//
// CRITICAL: leaf buttons must NOT have a `subButtons` key on the returned object,
// even with an undefined value. The iOS rendering path at toIosMenuSubMenuConfig
// uses `"subButtons" in button` as the leaf-vs-submenu discriminator, so setting
// `subButtons: undefined` on a leaf would route it through the submenu config and
// break the native menu.
export function applyOfflineGate(button: MenuButton, hasInternet: boolean): MenuButton {
	const offlineDisabled = button.requiresOnline === true && !hasInternet

	if (button.subButtons) {
		return {
			...button,
			disabled: button.disabled || offlineDisabled,
			subButtons: button.subButtons.map(b => applyOfflineGate(b, hasInternet))
		}
	}

	return {
		...button,
		disabled: button.disabled || offlineDisabled
	}
}

export function findButtonById(buttons: MenuButton[], id: string): MenuButton | null {
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

export function checkIfButtonIdsAreUnique(buttons: MenuButton[]): boolean {
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

export function toReactNativeMenuActions({
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

export function iosMenuAttributesFromButton(button: MenuButton): MenuAttributes[] {
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

export function toIosMenuSubMenuConfig(button: MenuButton): MenuElementConfig {
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

export function toIosMenuElementConfig(button: MenuButton): MenuElementConfig {
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
	// Opt-in for FLAT rows (drive/tags/chat-list/playlist) whose resting background is transparent.
	// Backs the iOS lift snapshot with an opaque tertiary fill clipped to LIFT_PREVIEW_BORDER_RADIUS,
	// so the preview lifts opaque + rounded WITHOUT touching the row's resting appearance. Card rows
	// (notes / chat bubble) must NOT set this — they already lift opaque from their own rounded children,
	// and a flat fill would square off their larger radius.
	previewBackground?: boolean
}

const MenuInnerIos = ({ children, ...props }: MenuProps) => {
	const bgBackgroundTertiary = useResolveClassNames("bg-background-tertiary")

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
				props.previewConfig
					? props.previewConfig
					: props.renderPreview
						? {
								previewSize: "INHERIT",
								preferredCommitStyle: "dismiss",
								isResizeAnimated: true,
								previewType: "CUSTOM"
							}
						: props.previewBackground
							? {
									backgroundColor: bgBackgroundTertiary.backgroundColor as string,
									borderRadius: LIFT_PREVIEW_BORDER_RADIUS
								}
							: undefined
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
}

const MenuInnerAndroid = ({ children, ...props }: MenuProps) => {
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
}

const MenuInner = ({ children, ...props }: MenuProps) => {
	const isOnline = useIsOnline()

	// Apply the per-button requiresOnline gate once; downstream iOS/Android
	// rendering paths see a fully-resolved `disabled` value per button.
	const buttons = props.buttons?.map(button => applyOfflineGate(button, isOnline))
	const effectiveProps: Omit<MenuProps, "children"> = { ...props, buttons }

	if (effectiveProps.disabled) {
		return children
	}

	if (Platform.OS === "ios") {
		return <MenuInnerIos {...effectiveProps}>{children}</MenuInnerIos>
	}

	return <MenuInnerAndroid {...effectiveProps}>{children}</MenuInnerAndroid>
}

export const Menu = withUniwind(MenuInner) as typeof MenuInner

export default Menu
