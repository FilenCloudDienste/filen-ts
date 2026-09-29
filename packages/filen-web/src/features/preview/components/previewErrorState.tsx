import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

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
