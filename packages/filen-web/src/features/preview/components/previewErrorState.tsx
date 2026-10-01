import type { ComponentProps, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"

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

// The viewer-sized spinner, inheriting the overlay's foreground color.
export function PreviewLoading() {
	return (
		<LoadingState
			size="lg"
			className="text-inherit"
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
