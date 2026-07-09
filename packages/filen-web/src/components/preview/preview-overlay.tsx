import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { previewType } from "@/lib/drive/preview.logic"
import { startDownloads } from "@/lib/drive/download"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { usePreviewBytes } from "@/components/preview/use-preview-bytes"
import { ImageViewer } from "@/components/preview/image-viewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface PreviewOverlayProps {
	variant: DriveVariant
	// Frozen previewable-sibling snapshot taken at open time (directory-listing.tsx's handleOpen) — the
	// pager's whole candidate list, not just the opened item.
	items: DriveItem[]
	index: number
	onStep: (delta: 1 | -1) => void
	onClose: () => void
}

// Full-bleed preview surface, mounted by the drive dialog host (directory-listing.tsx) exactly like its
// sibling dialog kinds — composed directly from Base UI's dialog primitives (not the shared centered
// ui/dialog.tsx) since no full-screen surface exists yet to reuse. Unlike every other dialog in this
// app, closing here is NEVER blocked on a pending state: a preview download is a read-only, ephemeral
// fetch that usePreviewBytes already cancels on unmount, not a write worth protecting against an
// interrupted close.
export function PreviewOverlay({ variant, items, index, onStep, onClose }: PreviewOverlayProps) {
	const { t } = useTranslation(["preview", "common"])
	const item = items[index]

	function handleOpenChange(next: boolean): void {
		if (!next) {
			onClose()
		}
	}

	if (!item) {
		return null
	}

	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={handleOpenChange}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup className="fixed inset-0 z-50 flex flex-col bg-background duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
					<header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-4">
						<PreviewName name={name} />
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index <= 0}
							aria-label={t("previewPreviousAction")}
							onClick={() => {
								onStep(-1)
							}}
						>
							<ChevronLeftIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index >= items.length - 1}
							aria-label={t("previewNextAction")}
							onClick={() => {
								onStep(1)
							}}
						>
							<ChevronRightIcon />
						</Button>
						{variant !== "trash" ? (
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("previewDownloadAction")}
								onClick={() => {
									void startDownloads([item])
								}}
							>
								<DownloadIcon />
							</Button>
						) : null}
						<DialogPrimitive.Close
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("common:close")}
								/>
							}
						>
							<XIcon />
						</DialogPrimitive.Close>
					</header>
					<div className="min-h-0 flex-1">
						<PreviewBody
							key={item.data.uuid}
							item={item}
						/>
					</div>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// Middle-ish ellipsis for a long filename: the head truncates with a CSS ellipsis while the tail
// (typically the extension) always stays visible, rather than the browser's default end-truncation
// swallowing it. Also carries the dialog's required accessible title.
function PreviewName({ name }: { name: string }) {
	const TAIL_LENGTH = 16
	const splitAt = name.length - TAIL_LENGTH

	return (
		<DialogPrimitive.Title className="flex min-w-0 flex-1 font-heading text-sm font-medium">
			{splitAt > 0 ? (
				<>
					<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{name.slice(0, splitAt)}</span>
					<span className="shrink-0 whitespace-nowrap">{name.slice(splitAt)}</span>
				</>
			) : (
				<span className="truncate">{name}</span>
			)}
		</DialogPrimitive.Title>
	)
}

// Loads the open item's bytes and dispatches to the right viewer — remounted (keyed by uuid) on every
// item change so its pending/success/error state never flashes the previous item's content.
function PreviewBody({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const { status, bytes, dto } = usePreviewBytes(item)

	if (status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (status === "error") {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
				{dto ? errorLabel(dto) : null}
			</div>
		)
	}

	if (!bytes) {
		return null
	}

	// Narrows `data.decryptedMeta` to the file-arm's DecryptedFileMeta (which alone carries `.mime`) —
	// previewType/canPreview already guarantee a file arm for every item that ever reaches this
	// component, but that guarantee lives in a plain function's return value, not a type predicate, so
	// TS needs this explicit narrow before a `.mime` access type-checks.
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	switch (previewType(item)) {
		case "image":
			return (
				<ImageViewer
					bytes={bytes}
					mime={base.data.decryptedMeta?.mime}
					alt={base.data.decryptedMeta?.name ?? base.data.uuid}
				/>
			)
		// Every other previewable category has no viewer yet — later tasks replace this branch with a
		// real one per category as they land, shrinking this fallback over time.
		case "video":
		case "audio":
		case "pdf":
		case "docx":
		case "text":
		case "code":
		case "markdown":
		case "other":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
	}
}
