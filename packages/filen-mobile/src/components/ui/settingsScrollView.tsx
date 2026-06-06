import { GestureHandlerScrollView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { type View as RNView } from "react-native"

export function SettingsScrollView({
	children,
	...props
}: React.PropsWithChildren<React.ComponentProps<typeof GestureHandlerScrollView>> & React.RefAttributes<RNView>) {
	const insets = useSafeAreaInsets()

	return (
		<GestureHandlerScrollView
			className="bg-transparent flex-1"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="px-4 gap-4"
			showsHorizontalScrollIndicator={false}
			contentContainerStyle={{
				paddingBottom: insets.bottom
			}}
			{...props}
		>
			{children}
		</GestureHandlerScrollView>
	)
}
