import { withUniwind } from "uniwind"
import {
	PressableOpacity as PresstoPressableOpacity,
	PressableScale as PresstoPressableScale,
	PressableWithoutFeedback as PresstoPressableWithoutFeedback,
	PressablesGroup as PresstoPressablesGroup
} from "pressto"
import { cn } from "@filen/utils"

export const PressableOpacity = withUniwind(PresstoPressableOpacity)

export const PressableScale = withUniwind(PresstoPressableScale)

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
