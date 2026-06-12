import { type ReactNode, type ComponentProps } from "react"
import { type TextProps } from "react-native"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import { hairlineBorderBottom } from "@/lib/hairline"

// Shared "list row" primitive — the flat avatar-row used across contacts, participants (notes/chats),
// file versions, note history, events, the chat-input pickers, etc. It is a pure LAYOUT/SLOT shell:
// it owns the row geometry (px-4 outer, inset inner with gap/padding/optional separator, selection
// tint, optional animated leading checkbox) and delegates ALL content + behavior to slots/props.
//
// Anatomy (left → right):
//   [animated checkbox?] [leading?] [ title / subtitle ] [trailing?]
//
// Menu model — the row never owns a menu:
//   • Visible "⋯" dropdown → pass it as `trailing`, e.g.
//       trailing={<Menu type="dropdown" buttons={...}><EllipsisMenuTrigger /></Menu>}
//   • Long-press context menu → the CALLER wraps the row, e.g.
//       <Menu type="context" buttons={...}><ListRow ... /></Menu>
//   `onLongPress` is a pure passthrough (never captured here) so reorderable lists keep working.
//
// Out of scope (do NOT try to express through this primitive): the drive `Item` row (its menu is the
// row's parent, its leading hosts absolutely-positioned overlay badges, it has dual selection stores
// and a menu-open tint) and the notes `Note` card (neighbor-aware rounded-card corners + multi-line
// embedded body). The `settingsGroup`, `detailRow`, profile heroes and tag/chip pickers are separate
// component families and stay independent.

type EllipsizeMode = NonNullable<TextProps["ellipsizeMode"]>

export type ListRowDensity = "compact" | "comfortable" | "relaxed"

// Vertical padding per density, applied to the inner row container. "comfortable" (py-2) is the
// canonical participant/contact row; "compact" (py-1.5) matches the chat-input pickers; "relaxed"
// (py-3) matches incoming-share / camera-upload-error rows.
const DENSITY_PADDING: Record<ListRowDensity, string> = {
	compact: "py-1.5",
	comfortable: "py-2",
	relaxed: "py-3"
}

// Default whole-row selection tint. Override via `selectedClassName` (e.g. the notes Tag row tints
// with bg-background-secondary instead).
export const LIST_ROW_SELECTED_CLASS_NAME = "bg-background-tertiary"

// Pure: outer container className (the selection-tint + disabled host). Exported for unit testing and
// for callers that need to extend it. Order is base → state → caller override so `className` wins.
export function listRowOuterClassName(opts: {
	selected?: boolean
	disabled?: boolean
	selectedClassName?: string
	className?: string
}): string {
	return cn(
		"flex-row items-center px-4 bg-transparent",
		opts.selected && (opts.selectedClassName ?? LIST_ROW_SELECTED_CLASS_NAME),
		opts.disabled && "opacity-50",
		opts.className
	)
}

// Pure: inner container className (carries the gap, vertical padding and the optional inset separator).
export function listRowInnerClassName(opts: { separator?: boolean; density?: ListRowDensity; innerClassName?: string }): string {
	return cn(
		"flex-row items-center gap-4 bg-transparent flex-1",
		DENSITY_PADDING[opts.density ?? "comfortable"],
		opts.separator && "border-separator",
		opts.innerClassName
	)
}

export type ListRowProps = {
	// Leading slot — any node: <Avatar />, an icon-chip, a tile (with its own overlay badge), an
	// <Image />, a small status icon, or nothing. Rendered after the selection checkbox.
	leading?: ReactNode
	// Body. A string is rendered in the default styles; a node is rendered as-is (use a node for
	// composite titles like a mute-icon prefix, or a multi-state subtitle).
	title?: ReactNode
	subtitle?: ReactNode
	titleClassName?: string
	subtitleClassName?: string
	titleEllipsizeMode?: EllipsizeMode
	subtitleEllipsizeMode?: EllipsizeMode
	// Trailing slot — ⋯ dropdown menu, inline action buttons, a close-X, chevron, switch, progress,
	// or nothing. Sits outside the press target so its own controls stay tappable.
	trailing?: ReactNode
	// Selection. `selectable` reveals the leading checkbox; `selected` drives the tint + checkbox
	// value; `onSelectedChange` makes the checkbox interactive (omit it for an inert checkbox whose
	// selection is driven by the row's `onPress`). `animateCheckbox` fades the checkbox in/out.
	selectable?: boolean
	selected?: boolean
	onSelectedChange?: () => void
	animateCheckbox?: boolean
	// Press. The tap target wraps the leading + body (not the trailing). `onLongPress` is a pure
	// passthrough (e.g. a reorderable-list drag handle) and is never intercepted.
	onPress?: () => void
	onLongPress?: () => void
	// Appearance.
	separator?: boolean
	disabled?: boolean
	density?: ListRowDensity
	selectedClassName?: string
	className?: string
	innerClassName?: string
	testID?: string
}

// Render a body line: wrap a string in the default Text style, or pass a node through untouched.
function listRowBody(value: ReactNode, baseClassName: string, className: string | undefined, ellipsizeMode: EllipsizeMode): ReactNode {
	if (value === null || value === undefined) {
		return null
	}

	if (typeof value === "string") {
		return (
			<Text
				className={cn(baseClassName, className)}
				numberOfLines={1}
				ellipsizeMode={ellipsizeMode}
			>
				{value}
			</Text>
		)
	}

	return value
}

export const ListRow = (props: ListRowProps) => {
	const checkbox = (
		<Checkbox
			value={props.selected ?? false}
			onValueChange={props.onSelectedChange}
			hitSlop={16}
		/>
	)

	const content = (
		<>
			{props.leading}
			<View className="flex-col bg-transparent gap-0.5 flex-1">
				{listRowBody(props.title, "text-foreground", props.titleClassName, props.titleEllipsizeMode ?? "middle")}
				{listRowBody(props.subtitle, "text-muted-foreground text-xs", props.subtitleClassName, props.subtitleEllipsizeMode ?? "middle")}
			</View>
		</>
	)

	const pressable = props.onPress || props.onLongPress

	return (
		<View
			testID={props.testID}
			className={listRowOuterClassName({
				selected: props.selected,
				disabled: props.disabled,
				selectedClassName: props.selectedClassName,
				className: props.className
			})}
		>
			<View
				className={listRowInnerClassName({
					separator: props.separator,
					density: props.density,
					innerClassName: props.innerClassName
				})}
				style={props.separator ? hairlineBorderBottom : undefined}
			>
				{props.selectable &&
					(props.animateCheckbox === false ? (
						<View className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0">{checkbox}</View>
					) : (
						<AnimatedView
							className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
							entering={FadeIn}
							exiting={FadeOut}
						>
							{checkbox}
						</AnimatedView>
					))}
				{pressable ? (
					<PressableScale
						className="flex-row items-center gap-3 bg-transparent flex-1"
						onPress={props.onPress}
						onLongPress={props.onLongPress}
					>
						{content}
					</PressableScale>
				) : (
					<View className="flex-row items-center gap-3 bg-transparent flex-1">{content}</View>
				)}
				{props.trailing}
			</View>
		</View>
	)
}

// Companion section-header for sectioned lists (contacts / notes group their lists with these). Render
// it directly in a list's `renderItem` header branch. Matches the existing ContactSectionHeader style;
// pass an `icon` for the notes-style leading glyph, or `className` to tweak padding.
export const ListRowSectionHeader = ({
	title,
	icon,
	className
}: {
	title: string
	icon?: ComponentProps<typeof Ionicons>["name"]
	className?: string
}) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className={cn("w-full h-auto px-4 py-2 pt-4 flex-row items-center gap-2 bg-transparent", className)}>
			{icon ? (
				<Ionicons
					name={icon}
					size={18}
					color={textForeground.color}
				/>
			) : null}
			<Text className="text-lg">{title}</Text>
		</View>
	)
}

export default ListRow
