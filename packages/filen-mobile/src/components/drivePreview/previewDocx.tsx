import { memo } from "react"
import View from "@/components/ui/view"
import DocxPreview from "@/components/docxPreview"
import { Buffer } from "react-native-quick-crypto"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import fileCache from "@/lib/fileCache"
import type { DriveItemFileExtracted } from "@/types"
import { ActivityIndicator } from "react-native"

const PreviewDocx = memo(({ item }: { item: DriveItemFileExtracted }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const query = useSimpleQuery(async signal => {
		const file = await fileCache.get({
			item,
			signal
		})

		return Buffer.from(await file.bytes()).toString("base64")
	})

	if (query.status !== "success") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	return (
		<View className="bg-background flex-1">
			<DocxPreview
				base64={query.data}
				paddingTop={headerHeight ? headerHeight : undefined}
				paddingBottom={insets.bottom}
			/>
		</View>
	)
})

export default PreviewDocx
