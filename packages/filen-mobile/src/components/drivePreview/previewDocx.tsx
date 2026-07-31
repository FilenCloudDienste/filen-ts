import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import DocxPreview from "@/components/docxPreview"
import { MAX_DOCX_BYTES } from "@/components/docxPreview/constants"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useFileUriQuery from "@/queries/useFileUri.query"
import useRangeSource from "@/hooks/useRangeSource"
import { ZIP_MAGIC } from "@/lib/rangeTransfer"
import { ActivityIndicator } from "react-native"
import { useTranslation } from "react-i18next"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"

const PreviewDocx = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const query = useFileUriQuery(
		item.type === "external"
			? {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
			: {
					type: "drive",
					data: {
						uuid: item.data.data.uuid,
						// By-value so a cross-directory search hit resolves its bytes.
						item: item.data
					}
				}
	)

	// A .docx is a zip, so the header check is on the archive signature rather than on anything
	// Office-specific — enough to tell a renamed file from a document before the renderer sees it.
	const source = useRangeSource(query.status === "success" ? query.data.uri : null, {
		maxBytes: MAX_DOCX_BYTES,
		magic: ZIP_MAGIC
	})

	if (query.status === "pending" && query.fetchStatus === "fetching") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	if (query.status !== "success" && query.fetchStatus === "paused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
			</View>
		)
	}

	if (query.status === "error") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="warning-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
				<PressableScale
					className="mt-4"
					onPress={() => query.refetch()}
					hitSlop={10}
				>
					<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
				</PressableScale>
			</View>
		)
	}

	// Refusals are typed rather than collapsed into the generic error state: "larger than the viewer
	// will open" is advice and "this is not a document" is a different fact, and a lone retry button
	// answers neither of them.
	if (source.status === "refused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name={source.reason === "tooLarge" ? "document-outline" : "warning-outline"}
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">
					{source.reason === "tooLarge"
						? t("document_too_large")
						: source.reason === "wrongFormat"
							? t("invalid_document")
							: t("preview_load_failed")}
				</Text>
			</View>
		)
	}

	if (source.status === "ready") {
		return (
			<View className="bg-background flex-1">
				<DocxPreview
					// A new document always gets a new WebView. Reusing one is what makes the previous
					// document's retained DOM a cost the next one pays.
					key={galleryItemKey(item)}
					readRange={source.readRange}
					fileSize={source.size}
					paddingTop={headerHeight ? headerHeight : undefined}
					paddingBottom={insets.bottom}
				/>
			</View>
		)
	}

	return (
		<View className="bg-background flex-1 items-center justify-center">
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewDocx
