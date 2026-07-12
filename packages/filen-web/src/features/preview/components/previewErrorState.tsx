import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

// Shared LABEL-FIRST error state for every buffered/streamed viewer's load-failure branch — a centered
// message plus an optional Retry action, reused instead of each viewer hand-rolling its own bare error
// text (the previous shape). `onRetry` is omitted only by call sites with genuinely nothing to retry
// (there are none left after this change, but the prop stays optional so a future no-retry state — e.g.
// a hard "unsupported" message — can still reuse this without inventing a second component).
export function PreviewErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
	const { t } = useTranslation("common")

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm text-destructive">{message}</p>
			{onRetry ? (
				<Button
					variant="outline"
					onClick={onRetry}
				>
					{t("tryAgain")}
				</Button>
			) : null}
		</div>
	)
}
