import { memo } from "react"
import { withUniwind } from "uniwind"
import {
	PressableOpacity as PresstoPressableOpacity,
	PressableScale as PresstoPressableScale,
	PressableWithoutFeedback as PresstoPressableWithoutFeedback,
	PressablesGroup as PresstoPressablesGroup
} from "pressto"
import { cn } from "@filen/utils"

export const PressableOpacity = withUniwind(memo(PresstoPressableOpacity))

export const PressableScale = withUniwind(memo(PresstoPressableScale))

export const PressableWithoutFeedback = withUniwind(memo(PresstoPressableWithoutFeedback))

export const PressablesGroup = withUniwind(memo(PresstoPressablesGroup))

export const AndroidIconButton = memo(
	(props: React.ComponentProps<typeof PressableOpacity> & { className?: string; children?: React.ReactNode }) => {
		return (
			<PressableOpacity
				{...props}
				className={cn("rounded-full p-1.5", props.className)}
			>
				{props.children}
			</PressableOpacity>
		)
	}
)
