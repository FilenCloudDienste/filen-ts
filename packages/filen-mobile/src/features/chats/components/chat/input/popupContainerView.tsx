import { useWindowDimensions } from "react-native"
import { CrossGlassContainerView, GestureHandlerScrollView } from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { SlideInDown, SlideOutDown } from "react-native-reanimated"
import useChatsStore from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { cn } from "@filen/shared"

export const PopupContainerView = ({
	children,
	scrollViewClassName,
	scrollViewProps
}: {
	children: React.ReactNode
	scrollViewClassName?: string
	scrollViewProps?: React.ComponentProps<typeof GestureHandlerScrollView>
}) => {
	const inputViewLayout = useChatsStore(useShallow(state => state.inputViewLayout))
	const windowDimensions = useWindowDimensions()

	return (
		<AnimatedView
			entering={SlideInDown}
			exiting={SlideOutDown}
			className="absolute left-0 right-0 px-4 z-20"
			style={{
				bottom: inputViewLayout.height + 8
			}}
		>
			<CrossGlassContainerView
				className="rounded-3xl w-full overflow-hidden"
				disableLiquidGlass={true}
			>
				<GestureHandlerScrollView
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={true}
					className={cn("px-3 py-2", scrollViewClassName)}
					automaticallyAdjustContentInsets={true}
					style={{
						maxHeight: Math.max(128, windowDimensions.height / 4)
					}}
					{...scrollViewProps}
				>
					{children}
				</GestureHandlerScrollView>
			</CrossGlassContainerView>
		</AnimatedView>
	)
}

export default PopupContainerView
