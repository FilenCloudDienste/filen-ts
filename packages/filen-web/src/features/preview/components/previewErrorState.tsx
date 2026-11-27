import { use, type ComponentProps, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { cn, driveItemName } from "@filen/shared"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { CARD_SURFACE_CLASS } from "@/components/ui/surface"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import { ImagePlaceholderContext } from "@/features/preview/lib/imageDisplay"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { formatItemSize } from "@/features/drive/lib/format"
import type { DriveItem } from "@/features/drive/lib/item"

// Shared LABEL-FIRST error state for every buffered/streamed viewer's load-failure branch — a centered
// message plus a Retry action, reused instead of each viewer hand-rolling its own bare error text. A
// failure no retry can fix omits Retry and offers `action` instead.
export function PreviewErrorState({ message, onRetry, action }: { message: string; onRetry?: () => void; action?: ReactNode }) {
	const { t } = useTranslation("common")

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm text-destructive">{message}</p>
			{onRetry !== undefined ? (
				<Button
					variant="outline"
					onClick={onRetry}
				>
					{t("tryAgain")}
				</Button>
			) : null}
			{action}
		</div>
	)
}

// The host's Download (see PreviewDownloadableProvider), offered where the preview cannot show the file;
// nothing where the host offers none. Disabled offline, like the header's own.
export function PreviewDownloadButton({ variant, size }: Pick<ComponentProps<typeof Button>, "variant" | "size">) {
	const { t } = useTranslation(["preview", "common"])
	const download = usePreviewDownload()
	const isOnline = useIsOnline()

	if (download === null) {
		return null
	}

	return (
		<Button
			variant={variant ?? "outline"}
			size={size}
			disabled={!isOnline}
			title={!isOnline ? t("common:offlineActionDisabled") : undefined}
			onClick={download}
		>
			<DownloadIcon data-icon="inline-start" />
			{t("previewDownloadAction")}
		</Button>
	)
}

// The one state for a file the preview cannot show (unsupported, too large, unreadable): a centered card with the
// file's icon, name and size, a calm message, the host's Download and at most one other action.
export function PreviewUnsupportedState({ item, message, secondary }: { item: DriveItem; message: string; secondary?: ReactNode }) {
	const download = usePreviewDownload()

	return (
		<div className="flex size-full items-center justify-center p-6">
			<div className={cn("flex w-full max-w-sm flex-col items-center gap-3 px-6 py-8 text-center", CARD_SURFACE_CLASS)}>
				<ItemIcon
					item={item}
					className="size-12"
				/>
				<p className="flex max-w-full items-baseline gap-1.5 font-medium">
					<span className="min-w-0 truncate">{driveItemName(item)}</span>
					<span
						aria-hidden="true"
						className="text-muted-foreground"
					>
						·
					</span>
					<span className="shrink-0 text-muted-foreground">{formatItemSize(item)}</span>
				</p>
				<p className="text-muted-foreground">{message}</p>
				{download !== null || secondary !== undefined ? (
					<div className="flex flex-wrap justify-center gap-2">
						<PreviewDownloadButton />
						{secondary}
					</div>
				) : null}
			</div>
		</div>
	)
}

// A text-family file whose bytes are not text: its card, with a way to see them anyway (read-only).
export function PreviewNotTextState({ item, onShowAnyway }: { item: DriveItem; onShowAnyway: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<PreviewUnsupportedState
			item={item}
			message={t("previewNotText")}
			secondary={
				<Button
					variant="outline"
					onClick={onShowAnyway}
				>
					{t("previewShowAnyway")}
				</Button>
			}
		/>
	)
}

// The viewer-sized spinner, inheriting the overlay's foreground color; over the file's thumbnail, blurred, where an
// image viewer has one in memory.
export function PreviewLoading() {
	const placeholder = use(ImagePlaceholderContext)
	const spinner = (
		<LoadingState
			size="lg"
			className="text-inherit"
		/>
	)

	if (placeholder === null) {
		return spinner
	}

	return (
		<div className="relative isolate size-full overflow-hidden">
			<ImagePlaceholder url={placeholder} />
			{spinner}
		</div>
	)
}

// The blurred thumbnail behind a picture still loading. Decorative; one already evicted from the cache shows nothing.
export function ImagePlaceholder({ url }: { url: string }) {
	return (
		<img
			src={url}
			alt=""
			aria-hidden="true"
			draggable={false}
			className="pointer-events-none absolute inset-0 -z-10 size-full scale-105 object-contain blur-xl select-none"
			onError={event => {
				event.currentTarget.hidden = true
			}}
		/>
	)
}

type PreviewGateResult = { status: "pending" } | { status: "success" } | { status: "error"; dto: ErrorDTO; refetch: () => void }

function isReady<T extends PreviewGateResult>(result: T): result is Extract<T, { status: "success" }> {
	return result.status === "success"
}

// The pending/error gate over a usePreviewBytes/useRawPreview result; `children` renders the loaded value.
export function PreviewGate<T extends PreviewGateResult>({
	result,
	children
}: {
	result: T
	children: (ready: Extract<T, { status: "success" }>) => ReactNode
}) {
	if (isReady(result)) {
		return children(result)
	}

	if (result.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(result.dto)}
				onRetry={result.refetch}
			/>
		)
	}

	return <PreviewLoading />
}
