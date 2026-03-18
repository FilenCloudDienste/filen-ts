import { memo, useMemo } from "@/lib/memo"
import { router, useLocalSearchParams } from "expo-router"
import { type DriveItemFileExtracted, type DriveItem } from "@/types"
import { Buffer } from "react-native-quick-crypto"
import { unpack } from "@/lib/msgpack"
import { type DrivePath } from "@/hooks/useDrivePath"
import useEffectOnce from "@/hooks/useEffectOnce"
import { getPreviewType } from "@/lib/utils"
import Gallery from "@/components/drivePreview/gallery"
import type { AnyDirWithContext } from "@filen/sdk-rs"

const Return = memo(() => {
	useEffectOnce(() => {
		router.dismissAll()
	})

	return null
})

const DrivePreview = memo(() => {
	const searchParams = useLocalSearchParams<{
		drivePath?: string
		item?: string
		parent?: string
	}>()

	const { drivePath, item, parent } = useMemo((): {
		drivePath: DrivePath | null
		item: DriveItemFileExtracted | null
		parent: AnyDirWithContext | null
	} => {
		if (!searchParams.item || !searchParams.drivePath) {
			return {
				drivePath: null,
				item: null,
				parent: null
			}
		}

		let item: DriveItem | null = null
		let drivePath: DrivePath | null = null
		let parent: AnyDirWithContext | null = null

		try {
			if (searchParams.item) {
				item = unpack(Buffer.from(searchParams.item, "base64")) as DriveItem
			}

			if (searchParams.drivePath) {
				drivePath = unpack(Buffer.from(searchParams.drivePath, "base64")) as DrivePath
			}

			if (searchParams.parent) {
				parent = unpack(Buffer.from(searchParams.parent, "base64")) as AnyDirWithContext
			}
		} catch (e) {
			console.error(e)

			return {
				item: null,
				drivePath: null,
				parent: null
			}
		}

		if (item?.type !== "file" && item?.type !== "sharedFile") {
			return {
				item: null,
				drivePath: null,
				parent: null
			}
		}

		return {
			item,
			drivePath,
			parent
		}
	}, [searchParams])

	const previewType = useMemo(() => {
		return getPreviewType(item?.data.decryptedMeta?.name ?? "")
	}, [item?.data.decryptedMeta?.name])

	if (!drivePath || !item || previewType === "unknown") {
		return <Return />
	}

	return (
		<Gallery
			item={item}
			drivePath={drivePath}
			parent={parent ?? undefined}
		/>
	)
})

export default DrivePreview
