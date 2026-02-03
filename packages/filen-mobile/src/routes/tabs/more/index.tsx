import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import { memo } from "@/lib/memo"

export const More = memo(() => {
	return (
		<Fragment>
			<Header title="tbd_more" />
			<SafeAreaView edges={["left", "right"]}>
				<></>
			</SafeAreaView>
		</Fragment>
	)
})

export default More
