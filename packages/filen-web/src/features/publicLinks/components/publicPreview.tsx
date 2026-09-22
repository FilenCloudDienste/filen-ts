import { lazy, Suspense, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { PreviewAccessModeProvider } from "@/features/preview/lib/accessMode"
import { ImageViewer } from "@/features/preview/components/imageViewer"
import { MediaViewer } from "@/features/preview/components/mediaViewer"
import { Spinner } from "@/components/ui/spinner"

// The heavy category viewers are lazy — a text/pdf link shouldn't pull in the media stack, mirroring
// previewOverlay's own split.
const PdfViewer = lazy(() => import("@/features/preview/components/pdfViewer"))
const DocxViewer = lazy(() => import("@/features/preview/components/docxViewer"))
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))
const MarkdownViewer = lazy(() => import("@/features/preview/components/markdownViewer"))

function ViewerFallback() {
	return (
		<div className="flex size-full items-center justify-center">
			<Spinner className="size-6" />
		</div>
	)
}

// Inline preview for a public-link file, reusing the SAME viewer components the authed app uses — fed
// a fabricated DriveItem (linkedFileIntoDriveItem / a narrowed listing File) and wrapped in the anon
// access-mode provider so every byte read routes through the UNAUTHENTICATED worker method and the
// buffered (never service-worker-streamed) path. The caller (fileView) has already gated size via
// anonPreviewability, so an oversized file never reaches a viewer here.
export function PublicPreview({ item }: { item: DriveItem }) {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = driveItemName(base)
	const category = previewType(item)

	return (
		<PreviewAccessModeProvider mode="anon">
			<div className="size-full">
				<PublicPreviewBody
					item={item}
					category={category}
					alt={alt}
				/>
			</div>
		</PreviewAccessModeProvider>
	)
}

// Guarded against a missing category arm by the `default` arm at the bottom, the same way
// previewOverlay's own PreviewBody is.
function PublicPreviewBody({ item, category, alt }: { item: DriveItem; category: ReturnType<typeof previewType>; alt: string }): ReactNode {
	const { t } = useTranslation("preview")

	switch (category) {
		case "image":
			return (
				<ImageViewer
					item={item}
					alt={alt}
				/>
			)
		case "video":
		case "audio":
			return (
				<MediaViewer
					item={item}
					category={category}
					alt={alt}
				/>
			)
		case "pdf":
			return (
				<Suspense fallback={<ViewerFallback />}>
					<PdfViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "docx":
			return (
				<Suspense fallback={<ViewerFallback />}>
					<DocxViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "text":
		case "code":
			return (
				<Suspense fallback={<ViewerFallback />}>
					<TextViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "markdown":
			return (
				<Suspense fallback={<ViewerFallback />}>
					<MarkdownViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		// Reachable, unlike "other": anonPreviewability admits rawImage (previewType resolves a real
		// category for it), so this arm must render the labeled unsupported state rather than the
		// `null` below — a blank pane with a "Hide preview" button over it reads as a broken viewer.
		// Reuses the authed overlay's own preview:previewUnsupportedType copy, not a second string.
		case "rawImage":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
		// Unreachable: anonPreviewability (download.logic.ts) refuses an "other" item before FileHero
		// ever renders a preview pane for it.
		case "other":
			return null
		// `category` narrows to `never` here only while every PreviewCategory has an arm above, so adding
		// one without a viewer is a compile error on this assignment instead of a blank pane.
		default: {
			const unhandled: never = category

			return unhandled
		}
	}
}
