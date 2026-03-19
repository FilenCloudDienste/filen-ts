import { memo } from "@/lib/memo"
import View from "@/components/ui/view"
import DocxPreview from "@/components/docxPreview"
import { useQuery } from "@tanstack/react-query"
import { Buffer } from "react-native-quick-crypto"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fetch } from "expo/fetch"
import { DEFAULT_QUERY_OPTIONS_ETERNAL, useDefaultQueryParams } from "@/queries/client"

const PreviewDocx = memo(({ fileUrl }: { fileUrl: string }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const defaultQueryParams = useDefaultQueryParams()
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS_ETERNAL,
		...defaultQueryParams,
		queryKey: ["drivePreviewDocxContent", fileUrl],
		queryFn: async ({ signal }) => {
			const response = await fetch(fileUrl, {
				signal
			})

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`)
			}

			const arrayBuffer = await response.arrayBuffer()

			return Buffer.from(arrayBuffer).toString("base64")
		}
	})

	if (query.status !== "success") {
		// TODO: show loading state or error message
		return null
	}

	return (
		<View className="bg-transparent flex-1">
			<DocxPreview
				base64={query.data}
				paddingTop={headerHeight ? headerHeight + 8 : undefined}
				paddingBottom={insets.bottom}
			/>
		</View>
	)
})

export default PreviewDocx
