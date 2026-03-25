import { Stack } from "expo-router"
import { memo } from "react"
import View from "@/components/ui/view"
import Transfers from "@/components/transfers"

const Layout = memo(() => {
	return (
		<View className="flex-1">
			<Stack />
			<Transfers />
		</View>
	)
})

export default Layout
