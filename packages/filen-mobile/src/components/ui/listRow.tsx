import { type ReactNode } from "react"
import { type TextProps } from "react-native"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { Checkbox } from "@/components/ui/checkbox"
import { PressableScale } from "@/components/ui/pressables"
import { cn } from "@filen/shared"

// Shared "list row" primitive — the flat avatar-row used across contacts, participants (notes/chats),
// file versions, note history, events, etc. It is a pure LAYOUT/SLOT shell: it owns the row geometry
// (px-4 outer, inset inner with gap/padding/optional separator, selection tint, optional leading
// checkbox) and delegates ALL content + behavior to slots/props.
//
// Anatomy (left → right):
//   [checkbox?] [leading?] [ title / subtitle ] [trailing?]
//
// Menu model — the row never owns a menu:
//   • Visible "⋯" dropdown → pass it as `trailing`, e.g.
//       trailing={<Menu type="dropdown" buttons={...}><EllipsisMenuTrigger /></Menu>}
//   • Long-press context menu → the CALLER wraps the row, e.g.
//       <Menu type="context" buttons={...}><ListRow ... /></Menu>
//
// Out of scope (do NOT try to express through this primitive): the drive `Item` row (its menu is the
// row's parent, its leading hosts absolutely-positioned overlay badges, it has dual selection stores
// and a menu-open tint) and the notes `Note` card (neighbor-aware rounded-card corners + multi-line
// embedded body). The `settingsGroup`, `detailRow`, profile heroes and tag/chip pickers are separate
// component families and stay independent.

type EllipsizeMode = NonNullable<TextProps["ellipsizeMode"]>

export type ListRowProps = {
	// Leading slot — any node: <Avatar />, an icon-chip, a tile (with its own overlay badge), an
	// <Image />, a small status icon, or nothing. Rendered after the selection checkbox.
	leading?: ReactNode
	// Body. A string is rendered in the default styles; a node is rendered as-is (use a node for
	// composite titles like a mute-icon prefix, or a multi-state subtitle).
	title?: ReactNode
	subtitle?: ReactNode
	subtitleEllipsizeMode?: EllipsizeMode
	// Trailing slot — ⋯ dropdown menu, inline action buttons, a close-X, chevron, switch, progress,
	// or nothing. Sits outside the press target so its own controls stay tappable.
	trailing?: ReactNode
	// Selection. `selectable` reveals the leading checkbox; `selected` drives the tint + checkbox
	// value; `onSelectedChange` makes the checkbox interactive (omit it for an inert checkbox whose
	// selection is driven by the row's `onPress`). The checkbox never mounts with a reanimated
	// entering/exiting animation: inside recycled list rows those pin the view (and its hitbox)
	// at stale coordinates on Android/Fabric — misplaced/overlapping selection circles.
	selectable?: boolean
	selected?: boolean
	onSelectedChange?: () => void
	// Press. The tap target wraps the leading + body (not the trailing).
	onPress?: () => void
	// Appearance. "comfortable" (py-2, the default) is the canonical participant/contact row;
	// "relaxed" (py-3) matches incoming-share / sync-error rows.
	separator?: boolean
	disabled?: boolean
	density?: "comfortable" | "relaxed"
}

// Render a body line: wrap a string in the default Text style, or pass a node through untouched.
function listRowBody(value: ReactNode, className: string, ellipsizeMode: EllipsizeMode): ReactNode {
	if (value === null || value === undefined) {
		return null
	}

	if (typeof value === "string") {
		return (
			<Text
				className={className}
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
				{listRowBody(props.title, "text-foreground", "middle")}
				{listRowBody(props.subtitle, "text-muted-foreground text-xs", props.subtitleEllipsizeMode ?? "middle")}
			</View>
		</>
	)

	return (
		<View
			className={cn(
				"flex-row items-center px-4 bg-transparent",
				props.selected && "bg-background-tertiary",
				props.disabled && "opacity-50"
			)}
		>
			<View
				className={cn(
					"flex-row items-center gap-4 bg-transparent flex-1",
					props.density === "relaxed" ? "py-3" : "py-2",
					props.separator && "border-b border-separator"
				)}
			>
				{props.selectable && (
					<View className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0">{checkbox}</View>
				)}
				{props.onPress ? (
					<PressableScale
						className="flex-row items-center gap-3 bg-transparent flex-1"
						onPress={props.onPress}
						// No row here is pressable end to end — none opens a context menu, and most carry a
						// trailing dropdown outside the press target — so Android's ripple, masked to that
						// target, drew a chip floating inside the row rather than feedback for it. The scale
						// is the feedback instead, as on the app's other controls.
						rippleColor="transparent"
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

// Companion section-header for sectioned lists. Render it directly in a list's `renderItem` header
// branch.
export const ListRowSectionHeader = ({ title }: { title: string }) => {
	return (
		<View className="w-full h-auto px-4 py-2 pt-4 flex-row items-center gap-2 bg-transparent">
			<Text className="text-lg">{title}</Text>
		</View>
	)
}

export default ListRow
