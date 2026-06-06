import { ActivityIndicator } from "react-native"
import View from "@/components/ui/view"
import type React from "react"

const PreviewSlot = ({ isActive, children }: { isActive: boolean; children: React.ReactNode }) => {
	return isActive ? (
		<>{children}</>
	) : (
		<View className="bg-transparent flex-1 items-center justify-center">
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewSlot
