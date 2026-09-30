import { Stack } from "expo-router"
import { Fragment } from "react"
import PlaylistsSelectToolbar from "@/features/audio/components/playlistsSelectToolbar"

const Layout = () => {
	return (
		<Fragment>
			<Stack />
			<PlaylistsSelectToolbar />
		</Fragment>
	)
}

export default Layout
