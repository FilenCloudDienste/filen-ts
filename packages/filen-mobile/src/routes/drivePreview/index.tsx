import { memo } from "react"
import { useLocalSearchParams } from "expo-router"
import { type DriveItemFileExtracted, type DriveItem } from "@/types"
import { deserialize } from "@/lib/serializer"
import { type DrivePath } from "@/hooks/useDrivePath"
import Gallery from "@/components/drivePreview/gallery"
import DismissStack from "@/components/dismissStack"

export type SearchParams = {
	drivePath?: string
	item?: string
	external?: string
}

export type External = {
	name: string
	url: string
}

function parseParams(searchParams: SearchParams): {
	drivePath: DrivePath | null
	item: DriveItemFileExtracted | null
	external: External | null
} {
	let item: DriveItem | null = null
	let drivePath: DrivePath | null = null
	let external: External | null = null

	try {
		if (searchParams.item) {
			item = deserialize(searchParams.item) as DriveItem
		}

		if (searchParams.drivePath) {
			drivePath = deserialize(searchParams.drivePath) as DrivePath
		}

		if (searchParams.external) {
			external = JSON.parse(searchParams.external) as External
		}
	} catch (e) {
		console.error(e)

		return {
			item: null,
			drivePath: null,
			external: null
		}
	}

	if (item && item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
		item = null
	}

	return {
		item,
		drivePath,
		external
	}
}

const DrivePreview = memo(() => {
	const searchParams = useLocalSearchParams<SearchParams>()
	const { drivePath, item, external } = parseParams(searchParams)

	if (!external && (item === null || drivePath === null)) {
		return <DismissStack />
	}

	return (
		<Gallery
			initialItem={
				external
					? {
							type: "external",
							data: external
						}
					: {
							type: "drive",
							data: {
								item: item!,
								drivePath: drivePath!
							}
						}
			}
		/>
	)
})

export default DrivePreview
