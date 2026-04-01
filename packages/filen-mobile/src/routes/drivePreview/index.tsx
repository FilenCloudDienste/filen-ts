import { memo } from "react"
import { router, useLocalSearchParams } from "expo-router"
import { type DriveItemFileExtracted, type DriveItem } from "@/types"
import { Buffer } from "react-native-quick-crypto"
import { unpack } from "@/lib/msgpack"
import { type DrivePath } from "@/hooks/useDrivePath"
import useEffectOnce from "@/hooks/useEffectOnce"
import { getPreviewType } from "@/lib/utils"
import Gallery from "@/components/drivePreview/gallery"

const Return = memo(() => {
	useEffectOnce(() => {
		router.dismissAll()
	})

	return null
})

type SearchParams = {
	drivePath?: string
	item?: string
}

function parseParams(searchParams: SearchParams): {
	drivePath: DrivePath | null
	item: DriveItemFileExtracted | null
} {
	if (!searchParams.item || !searchParams.drivePath) {
		return {
			drivePath: null,
			item: null
		}
	}

	let item: DriveItem | null = null
	let drivePath: DrivePath | null = null

	try {
		if (searchParams.item) {
			item = unpack(Buffer.from(searchParams.item, "base64")) as DriveItem
		}

		if (searchParams.drivePath) {
			drivePath = unpack(Buffer.from(searchParams.drivePath, "base64")) as DrivePath
		}
	} catch (e) {
		console.error(e)

		return {
			item: null,
			drivePath: null
		}
	}

	if (item?.type !== "file" && item?.type !== "sharedFile" && item?.type !== "sharedRootFile") {
		return {
			item: null,
			drivePath: null
		}
	}

	return {
		item,
		drivePath
	}
}

const DrivePreview = memo(() => {
	const searchParams = useLocalSearchParams<SearchParams>()
	const { drivePath, item } = parseParams(searchParams)
	const previewType = getPreviewType(item?.data.decryptedMeta?.name ?? "")

	if (!drivePath || !item || previewType === "unknown") {
		return <Return />
	}

	return (
		<Gallery
			item={item}
			drivePath={drivePath}
		/>
	)
})

export default DrivePreview
