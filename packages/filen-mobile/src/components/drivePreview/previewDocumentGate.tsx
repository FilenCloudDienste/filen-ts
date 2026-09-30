import { type ReactNode } from "react"
import { type StyleProp, type ViewStyle } from "react-native"
import useFileUriQuery from "@/queries/useFileUri.query"
import useRangeSource, { type RangeSource } from "@/hooks/useRangeSource"
import useIsOnline from "@/hooks/useIsOnline"
import { isUnavailableOffline } from "@/components/drivePreview/previewAvailability"
import UnavailableOfflineNotice from "@/components/drivePreview/unavailableOfflineNotice"
import PreviewLoadFailedNotice from "@/components/drivePreview/previewLoadFailedNotice"
import { PreviewMessage, PreviewSpinner } from "@/components/drivePreview/previewStatus"
import { type GalleryItemTagged } from "@/components/drivePreview/gallery"
import { galleryItemFileSource } from "@/components/drivePreview/galleryRenderName"

// Resolves a gallery item to a local file and opens it for a DOM viewer, rendering the loading, offline,
// failed and refused pages until `children` can render the viewer. bg-background unless `style` overrides.
const PreviewDocumentGate = ({
	item,
	maxBytes,
	magic,
	refusedText,
	style,
	children
}: {
	item: GalleryItemTagged
	maxBytes: number
	magic?: string
	refusedText: {
		tooLarge: string
		wrongFormat?: string
		other: string
	}
	style?: StyleProp<ViewStyle>
	children: (source: Extract<RangeSource, { status: "ready" }>) => ReactNode
}) => {
	const isOnline = useIsOnline()
	const query = useFileUriQuery(galleryItemFileSource(item))
	const source = useRangeSource(query.status === "success" ? query.data.uri : null, {
		maxBytes,
		magic
	})

	if (isUnavailableOffline(query, isOnline)) {
		return (
			<UnavailableOfflineNotice
				className="bg-background"
				style={style}
			/>
		)
	}

	if (query.status === "error") {
		return (
			<PreviewLoadFailedNotice
				style={style}
				onRetry={() => query.refetch()}
			/>
		)
	}

	// Refusals are typed rather than collapsed into the generic error state: "larger than the viewer
	// will open" is advice and "this is not that format" is a different fact, and a lone retry button
	// answers neither of them.
	if (source.status === "refused") {
		return (
			<PreviewMessage
				icon={source.reason === "tooLarge" ? "document-outline" : "warning-outline"}
				text={
					source.reason === "tooLarge"
						? refusedText.tooLarge
						: source.reason === "wrongFormat"
							? (refusedText.wrongFormat ?? refusedText.other)
							: refusedText.other
				}
				style={style}
			/>
		)
	}

	if (source.status === "ready") {
		return children(source)
	}

	return <PreviewSpinner style={style} />
}

export default PreviewDocumentGate
