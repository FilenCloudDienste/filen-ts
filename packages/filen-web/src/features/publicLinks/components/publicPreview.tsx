import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { PreviewAccessModeProvider, PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"

// Inline preview for a public-link file, reusing the SAME viewer components the authed app uses — fed
// a fabricated DriveItem (linkedFileIntoDriveItem / a narrowed listing File) and wrapped in the anon
// access-mode provider so every byte read routes through the UNAUTHENTICATED worker method and the
// buffered (never service-worker-streamed) path. The caller (fileView) has already gated size via
// anonPreviewability, so an oversized file never reaches a viewer here. A link that disallows downloads
// still previews, with no viewer's own way to save the file.
export function PublicPreview({ item, linkScope, downloadable }: { item: DriveItem; linkScope: string; downloadable: boolean }) {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = driveItemName(base)
	const category = previewType(item)

	return (
		<PreviewAccessModeProvider
			mode="anon"
			linkScope={linkScope}
		>
			<PreviewDownloadableProvider downloadable={downloadable}>
				<div className="size-full">
					<ReadOnlyPreviewBody
						item={item}
						category={category}
						alt={alt}
					/>
				</div>
			</PreviewDownloadableProvider>
		</PreviewAccessModeProvider>
	)
}
