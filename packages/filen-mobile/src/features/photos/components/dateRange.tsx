import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import usePhotosStore from "@/features/photos/store/usePhotos.store"
import { simpleDateNoTime } from "@/lib/time"
import { useHeaderHeight } from "expo-router/react-navigation"

export const DateRange = () => {
	const visibleDateRange = usePhotosStore(useShallow(state => state.visibleDateRange))
	const headerHeight = useHeaderHeight()

	if (!visibleDateRange) {
		return null
	}

	const startDate = visibleDateRange.start !== null ? new Date(visibleDateRange.start) : null

	if (!startDate) {
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
				<Text className="text-sm">{simpleDateNoTime(startDate)}</Text>
			</CrossGlassContainerView>
		</View>
	)
}

export default DateRange
