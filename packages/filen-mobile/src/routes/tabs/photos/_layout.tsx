import { Stack } from "expo-router"
import { memo } from "react"
import View from "@/components/ui/view"

const Layout = memo(() => {
	return (
		<View className="flex-1">
			<Stack />
		</View>
	)
})

export default Layout
