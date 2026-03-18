import { memo } from "@/lib/memo"
import View from "@/components/ui/view"
import DocxPreview from "@/components/docxPreview"
import { useQuery } from "@tanstack/react-query"
import { Buffer } from "react-native-quick-crypto"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { fetch } from "expo/fetch"

const PreviewDocx = memo(({ fileUrl }: { fileUrl: string }) => {
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const query = useQuery({
		queryKey: ["drivePreviewDocxContent", fileUrl],
		queryFn: async () => {
			const response = await fetch(fileUrl)

			if (!response.ok) {
				throw new Error(`HTTP error: ${response.status}`)
			}

			const arrayBuffer = await response.arrayBuffer()

			return Buffer.from(arrayBuffer).toString("base64")
		},
		gcTime: 0,
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always"
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
