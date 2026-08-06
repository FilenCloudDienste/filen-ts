import { withUniwind } from "uniwind"
import {
	PressableOpacity as PresstoPressableOpacity,
	PressableScale as PresstoPressableScale,
	PressableWithoutFeedback as PresstoPressableWithoutFeedback,
	PressablesGroup as PresstoPressablesGroup
} from "pressto"
import { cn } from "@filen/utils"
import { useLongPressGuard } from "@/components/ui/longPressMenuGuard"

const PressableOpacityUniwind = withUniwind(PresstoPressableOpacity)

const PressableScaleUniwind = withUniwind(PresstoPressableScale)

// Android draws the press ripple as the underlying RNGH button's own BACKGROUND, masked to that
// button's own box (RNGestureHandlerButtonViewManager.updateBackground). Two consequences wherever a
// pressable is a row or a grid cell rather than a plain control:
//
//   • An opaque child — a card, a thumbnail — hides the ripple completely. Pass `foreground` there and
//     it paints over the children instead. Android-only (iOS never reads it); pressto leaves it out of
//     its prop type although it does reach native through the prop spread, hence this widening.
//   • The ripple can never be wider than the pressable. That only matters where the whole row also
//     responds — a row wrapped in a long-press context menu — in which case the row's gutter moves
//     onto the pressable so the two agree. A row whose only affordances are its own tap target and a
//     trailing dropdown wants the opposite: the ripple already marks exactly what was pressed.
type AndroidRippleProps = {
	foreground?: boolean
}

// PressableOpacity / PressableScale apply the long-press guard: inside a long-press context <Menu>, a
// press held long enough to engage the native context menu does NOT also fire onPress (so a long-press
// can never also navigate/open the row — see longPressMenuGuard.ts). Outside a context menu the guard
// is a transparent passthrough.
export const PressableOpacity = ({
	onPress,
	onPressIn,
	...props
}: React.ComponentProps<typeof PressableOpacityUniwind> & AndroidRippleProps) => {
	const guarded = useLongPressGuard(onPress, onPressIn)

	return (
		<PressableOpacityUniwind
			{...props}
			onPress={guarded.onPress}
			onPressIn={guarded.onPressIn}
		/>
	)
}

export const PressableScale = ({
	onPress,
	onPressIn,
	...props
}: React.ComponentProps<typeof PressableScaleUniwind> & AndroidRippleProps) => {
	const guarded = useLongPressGuard(onPress, onPressIn)

	return (
		<PressableScaleUniwind
			{...props}
			onPress={guarded.onPress}
			onPressIn={guarded.onPressIn}
		/>
	)
}

export const PressableWithoutFeedback = withUniwind(PresstoPressableWithoutFeedback)

export const PressablesGroup = withUniwind(PresstoPressablesGroup)

export const AndroidIconButton = (
	props: React.ComponentProps<typeof PressableOpacity> & { className?: string; children?: React.ReactNode }
) => {
	return (
		<PressableOpacity
			{...props}
			className={cn("rounded-full p-1.5", props.className)}
		>
			{props.children}
		</PressableOpacity>
	)
}
