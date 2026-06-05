import { Stack } from "expo-router"
import { Fragment } from "react"
import PlaylistToolbar from "@/features/audio/components/playlistToolbar"

const Layout = () => {
	return (
		<Fragment>
			<Stack />
			<PlaylistToolbar />
		</Fragment>
	)
}

export default Layout
