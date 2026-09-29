import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"

// Shared LABEL-FIRST error state for every buffered/streamed viewer's load-failure branch — a centered
// message plus a Retry action, reused instead of each viewer hand-rolling its own bare error text.
export function PreviewErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
	const { t } = useTranslation("common")

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm text-destructive">{message}</p>
			<Button
				variant="outline"
				onClick={onRetry}
			>
				{t("tryAgain")}
			</Button>
		</div>
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
