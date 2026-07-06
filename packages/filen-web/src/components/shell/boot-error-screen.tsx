import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"

interface BootErrorScreenProps {
	// The machine-readable boot failure reason (artifacts | pool | async-runtime). `coi` is handled
	// separately by routing to the dedicated /no-coi page, so it never reaches this screen. Both fields
	// are required-but-undefinable so the store's `X | undefined` selectors pass cleanly under
	// exactOptionalPropertyTypes.
	reason: string | undefined
	error: ErrorDTO | undefined
	onRetry: () => void
}

// Full-screen terminal boot failure with a retry. `errorLabel` resolves the localized, user-meaningful
// message (server/inner/outer, LABEL-FIRST); the raw reason is kept as a small technical footnote for
// support, not as the headline.
export function BootErrorScreen({ reason, error, onRetry }: BootErrorScreenProps) {
	const { t } = useTranslation()
	const detail = error ? errorLabel(error) : undefined

	return (
		<div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia
						variant="icon"
						className="bg-destructive/10 text-destructive"
					>
						<TriangleAlertIcon />
					</EmptyMedia>
					<EmptyTitle>{t("bootErrorTitle")}</EmptyTitle>
					{detail ? <EmptyDescription>{detail}</EmptyDescription> : null}
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry}>{t("retry")}</Button>
					{reason ? <span className="font-mono text-xs text-muted-foreground">{reason}</span> : null}
				</EmptyContent>
			</Empty>
		</div>
	)
}
