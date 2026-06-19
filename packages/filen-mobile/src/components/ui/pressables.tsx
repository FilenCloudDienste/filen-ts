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

// PressableOpacity / PressableScale apply the long-press guard: inside a long-press context <Menu>, a
// press held long enough to engage the native context menu does NOT also fire onPress (so a long-press
// can never also navigate/open the row — see longPressMenuGuard.ts). Outside a context menu the guard
// is a transparent passthrough.
export const PressableOpacity = ({ onPress, onPressIn, ...props }: React.ComponentProps<typeof PressableOpacityUniwind>) => {
	const guarded = useLongPressGuard(onPress, onPressIn)

	return (
		<PressableOpacityUniwind
			{...props}
			onPress={guarded.onPress}
			onPressIn={guarded.onPressIn}
		/>
	)
}

export const PressableScale = ({ onPress, onPressIn, ...props }: React.ComponentProps<typeof PressableScaleUniwind>) => {
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
