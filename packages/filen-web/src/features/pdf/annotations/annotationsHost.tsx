import { useEffect, useEffectEvent, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DownloadIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import { useCommentAuthor } from "@/features/office/components/commentAuthor"
import { applied, placeDrivePicture, placePicture, postComment } from "@/features/pdf/annotations/annotationActions"
import { annotationStoreOf, editingSession } from "@/features/pdf/annotations/annotationStore"
import { downloadAttachmentTold } from "@/features/pdf/annotations/attachments"
import { PdfCommentsPanel } from "@/features/pdf/comments/pdfCommentsPanel"
import type { PdfToolPanelProps } from "@/features/pdf/tools/registry"
import { isStampPicture } from "@/features/pdf/annotations/stampImage"
import { log } from "@/lib/log"

// What the annotation tools keep beside the pages, mounted once while the editor may be used (the selection tool's
// panel): the store's binding to the editor session, the author's name (asked the first time an annotation or comment
// is made), the Comments panel, the stamp picture's pickers, the attachments dialog, and dropping the selection on a
// press elsewhere.

// Presses there keep the selection.
const KEEPS_SELECTION = "[data-annotation], [data-pdf-annotation-popover], [data-comments-pane], [role='menu'], [role='dialog']"

export function PdfAnnotationsHost({ context, phone }: PdfToolPanelProps) {
	const { t } = useTranslation("preview")
	const store = annotationStoreOf(context.swap)
	const state = useSyncExternalStore(store.subscribe, store.getState)
	const phase = useSyncExternalStore(context.swap.subscribe, context.swap.getSnapshot)
	const session = phase.kind === "editing" ? phase.session : null
	const author = useCommentAuthor()
	const ask = useEffectEvent(() => author.ask())
	const fileInput = useRef<HTMLInputElement | null>(null)

	useEffect(() => {
		store.bind(session)
	}, [store, session])

	useEffect(() => {
		store.setAuthorAsk(() => ask())

		return () => {
			store.setAuthorAsk(null)
		}
	}, [store])

	useEffect(() => {
		const onDown = (event: PointerEvent): void => {
			const target = event.target instanceof Element ? event.target : null

			if (target?.closest(KEEPS_SELECTION) == null) store.select(null)
		}

		window.addEventListener("pointerdown", onDown, true)

		return () => {
			window.removeEventListener("pointerdown", onDown, true)
		}
	}, [store])

	const wanted = state.imageWanted

	// A place clicked for a picture from this device: the file chooser opens in the commit of that click.
	useLayoutEffect(() => {
		if (wanted?.source === "device") fileInput.current?.click()
	}, [wanted])

	const pictureFailed = (error: unknown): void => {
		log.warn("pdf", "stamp picture not read", { error })
		store.wantImage(null)
		toast.error(t("previewPdfAnnotImageFailed"))
	}

	const selected = state.selected
	const composing = state.composing
	const attachmentWords = { failed: t("previewPdfAnnotAttachmentFailed"), missing: t("previewPdfAnnotAttachmentMissing") }
	const attachments = state.attachmentsOpen ? store.attachments() : null

	return (
		<>
			<PdfCommentsPanel
				threads={store.commentThreads() ?? []}
				editable={context.editable}
				phone={phone}
				open={state.commentsOpen}
				onClose={() => {
					store.openComments(false)
				}}
				{...(selected === null ? {} : { selected: { page: selected.page, id: selected.id } })}
				onSelect={ref => {
					store.selectRef(ref)
				}}
				onReply={(root, text, name) =>
					applied(context, live => live.dispatch("annotations.reply", { ...root, text, author: name }))
				}
				onEdit={(ref, text) => applied(context, live => live.dispatch("annotations.text", { ...ref, text }))}
				onDelete={ref => applied(context, live => live.dispatch("annotations.delete", ref))}
				onSetState={(root, value, name) =>
					applied(context, live => live.dispatch("annotations.state", { ...root, state: value, author: name }))
				}
				{...(context.editable
					? {
							onNew: () => {
								context.activate("annotations.note")
							}
						}
					: {})}
				composing={composing !== null}
				onPost={(text, name) => (composing === null ? Promise.resolve(null) : postComment(context, store, composing, text, name))}
				onComposeEnd={() => {
					store.compose(null)
				}}
			/>
			{author.dialog}
			<input
				ref={fileInput}
				type="file"
				hidden
				accept="image/*,.heic,.heif,.hif"
				onChange={event => {
					const file = event.currentTarget.files?.[0]
					const target = store.getState().imageWanted

					event.currentTarget.value = ""

					if (file === undefined || target === null) {
						store.wantImage(null)

						return
					}

					void file
						.arrayBuffer()
						.then(buffer => placePicture(context, store, target, new Uint8Array(buffer), file.name))
						.catch(pictureFailed)
				}}
			/>
			{wanted?.source === "filen" ? (
				<DriveFilePickerDialog
					title={t("previewPdfAnnotImageFromFilen")}
					description={t("previewPdfAnnotImageFromFilenBody")}
					accept={isStampPicture}
					onPick={(item, signal) =>
						placeDrivePicture(context, store, wanted, item, signal).catch((error: unknown) => {
							if (!signal.aborted) pictureFailed(error)
						})
					}
					onClose={() => {
						store.wantImage(null)
					}}
				/>
			) : null}
			<Dialog
				open={state.attachmentsOpen}
				onOpenChange={open => {
					store.openAttachments(open)
				}}
			>
				<DialogContent data-preview-surface>
					<DialogHeader>
						<DialogTitle>{t("previewPdfAnnotAttachments")}</DialogTitle>
						<DialogDescription>{t("previewPdfAnnotAttachmentsBody")}</DialogDescription>
					</DialogHeader>
					{attachments === null ? (
						<p
							role="status"
							className="text-sm text-muted-foreground"
						>
							{t("previewPdfAnnotAttachmentsLoading")}
						</p>
					) : attachments.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("previewPdfAnnotAttachmentsEmpty")}</p>
					) : (
						<ul className="flex flex-col gap-1">
							{attachments.map(entry => (
								<li
									key={
										entry.source.kind === "document"
											? `d:${entry.source.key}`
											: `a:${String(entry.source.ref.page)}:${String(entry.source.ref.id)}`
									}
									className="flex items-center gap-2 text-sm"
								>
									<span className="min-w-0 flex-1 truncate">{entry.name}</span>
									{entry.size === null ? null : (
										<span className="shrink-0 text-xs text-muted-foreground">{formatBytes(entry.size)}</span>
									)}
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={t("previewPdfAnnotAttachmentDownload", { name: entry.name })}
										title={t("previewPdfAnnotAttachmentDownload", { name: entry.name })}
										onClick={() => {
											const live = editingSession(context.swap)

											if (live !== null) void downloadAttachmentTold(live, entry.source, attachmentWords)
										}}
									>
										<DownloadIcon />
									</Button>
								</li>
							))}
						</ul>
					)}
				</DialogContent>
			</Dialog>
		</>
	)
}
