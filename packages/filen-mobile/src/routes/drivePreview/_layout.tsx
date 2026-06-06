import { Stack } from "expo-router"

const Layout = () => {
	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: {
					backgroundColor: "transparent"
				}
			}}
		/>
	)
}

export default Layout
