import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { PreviewAccessModeProvider, PreviewDownloadableProvider, PreviewSiblingsProvider } from "@/features/preview/lib/accessMode"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"
import { ContentSniffGate } from "@/features/preview/components/contentSniffGate"
import { IworkPreview } from "@/features/iwork/components/iworkPreview"
import { PreviewReferenceSourceContext, type ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { SlideshowSlot } from "@/features/preview/components/slideshowSlot"
import type { SlideshowSlotValue } from "@/features/preview/lib/slideSignals"

const NO_SIBLINGS: readonly DriveItem[] = []

// Inline preview for a public-link file, reusing the SAME viewer components the authed app uses — fed
// a fabricated DriveItem (linkedFileIntoDriveItem / a narrowed listing File) and wrapped in the anon
// access-mode provider so every byte read goes through the SDK worker's UNAUTHENTICATED client: video and
// audio stream, through the service worker's range route fed by an unauthenticated range port (the service
// worker holds no key), or through MediaSource where no current service worker controls the page; the
// rest is buffered. The caller
// (fileView) has already gated the buffered categories' size via anonPreviewability. A link that
// disallows downloads still previews, with no viewer's own way to save the file. `siblings` are the
// other files of the link's directory, where a video's subtitles are found. A Pages, Numbers or Keynote document shows
// the rendering its package carries, the package listed and that one entry read through the public-link client's
// archive reader, as the drive's preview does. `slot` is a running slideshow's (useSlideshow, in the hero's pager).
export function PublicPreview({
	item,
	linkScope,
	downloadable,
	siblings,
	references,
	slot
}: {
	item: DriveItem
	linkScope: string
	downloadable: boolean
	siblings?: readonly DriveItem[] | undefined
	// Where a model's referenced files are found; none on a single file's link.
	references?: ReferenceSourceFactory | undefined
	slot?: SlideshowSlotValue | undefined
}) {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = driveItemName(base)

	return (
		<PreviewAccessModeProvider
			mode="anon"
			linkScope={linkScope}
		>
			<PreviewDownloadableProvider downloadable={downloadable}>
				<PreviewSiblingsProvider siblings={siblings ?? NO_SIBLINGS}>
					<PreviewReferenceSourceContext value={references ?? null}>
						<SlideshowSlot value={slot ?? null}>
							<div className="size-full">
								<ContentSniffGate
									item={item}
									asText={false}
									render={() => {
										const category = previewType(item)

										return category === "iwork" ? (
											<IworkPreview
												item={item}
												alt={alt}
											/>
										) : (
											<ReadOnlyPreviewBody
												item={item}
												category={category}
												alt={alt}
											/>
										)
									}}
								/>
							</div>
						</SlideshowSlot>
					</PreviewReferenceSourceContext>
				</PreviewSiblingsProvider>
			</PreviewDownloadableProvider>
		</PreviewAccessModeProvider>
	)
}
