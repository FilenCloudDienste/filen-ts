import { memo } from "@/lib/memo"
import ZoomableView from "@/components/ui/zoomableView"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"

const Preview = memo(() => {
	return (
		<View className="flex-1 bg-background items-center justify-center w-full h-full">
			<ZoomableView
				style={{
					flex: 1,
					width: "100%",
					height: "100%",
					alignItems: "center",
					justifyContent: "center"
				}}
			>
				<View className="bg-transparent flex-1 items-center justify-center">
					<Text>tbd</Text>
				</View>
			</ZoomableView>
		</View>
	)
})

export default Preview
