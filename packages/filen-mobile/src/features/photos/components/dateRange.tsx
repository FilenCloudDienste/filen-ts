import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { Platform } from "react-native"
import usePhotosStore from "@/features/photos/store/usePhotos.store"
import { simpleDateNoTime } from "@/lib/time"
import { useHeaderHeight } from "expo-router/react-navigation"

export const DateRange = () => {
	const visibleDate = usePhotosStore(state => state.visibleDate)
	const headerHeight = useHeaderHeight()

	if (visibleDate === null) {
		return null
	}

	return (
		<View
			className="absolute bg-transparent"
			style={{
				top:
					Platform.select({
						ios: headerHeight,
						default: 0
					}) + 8,
				right: 8,
				zIndex: 100
			}}
		>
			<CrossGlassContainerView className="p-2 items-center justify-center">
				<Text className="text-sm">{simpleDateNoTime(new Date(visibleDate))}</Text>
			</CrossGlassContainerView>
		</View>
	)
}

export default DateRange
