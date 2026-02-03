import { Stack } from "expo-router"
import { memo } from "@/lib/memo"
import View from "@/components/ui/view"

export const Layout = memo(() => {
	return (
		<View className="flex-1">
			<Stack />
		</View>
	)
})

export default Layout
