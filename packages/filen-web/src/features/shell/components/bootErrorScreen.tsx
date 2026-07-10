import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"

interface BootErrorScreenProps {
	// The machine-readable boot failure reason (artifacts | pool | async-runtime). `coi` and `opfs` are
	// handled separately by routing to their own dedicated pages (/no-coi, /no-opfs), so neither ever
	// reaches this screen. Both fields are required-but-undefinable so the store's `X | undefined`
	// selectors pass cleanly under exactOptionalPropertyTypes.
	reason: string | undefined
	error: ErrorDTO | undefined
}

// Full-screen terminal boot failure whose only recovery is a full page reload (mirroring /no-coi):
// re-running boot against the already-live worker cannot recover a failed thread pool / async runtime
// (initThreadPool is not idempotent), so a fresh document is the sole reliable path back. `errorLabel`
// resolves the localized, user-meaningful message (server/inner/outer, LABEL-FIRST); the raw reason is
// kept as a small technical footnote for support, not as the headline.
export function BootErrorScreen({ reason, error }: BootErrorScreenProps) {
	const { t } = useTranslation()
	const detail = error ? errorLabel(error) : undefined

	return (
		<div className="flex min-h-svh items-center justify-center bg-canvas p-6 text-foreground">
			<Empty className="max-w-md">
				<EmptyHeader>
					<EmptyMedia
						variant="icon"
						className="bg-destructive/10 text-destructive"
					>
						<TriangleAlertIcon />
					</EmptyMedia>
					<EmptyTitle>{t("bootErrorTitle")}</EmptyTitle>
					{detail ? <EmptyDescription className="select-text">{detail}</EmptyDescription> : null}
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => {
							window.location.reload()
						}}
					>
						{t("reload")}
					</Button>
					{reason ? <span className="font-mono text-xs text-muted-foreground select-text">{reason}</span> : null}
				</EmptyContent>
			</Empty>
		</div>
	)
}
