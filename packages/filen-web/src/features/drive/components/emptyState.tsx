import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FolderClosedIcon } from "lucide-react"
import { type ErrorDTO } from "@/lib/sdk/errors"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { driveEmptyStateCopy } from "@/features/drive/components/emptyState.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Discriminated on variant so an "error" render can never be constructed without its error/retry —
// the same two branches directoryListing.tsx's placeholder rendered inline, now shared with the real
// listing. "empty" additionally carries the listing surface its bespoke icon/copy is drawn from
// (driveEmptyStateCopy) plus an optional contextual action (directoryListing.tsx's inline "+ Add" for
// a writable, currently-empty location) — moveTargetDialog.tsx's own empty picker branch passes
// driveVariant="drive" (it only ever browses the owned directory tree) and no action (the picker is
// read-only browsing, never a write surface).
export type EmptyStateProps =
	{ variant: "empty"; driveVariant: DriveVariant; action?: ReactNode } | { variant: "error"; error: ErrorDTO; onRetry: () => void }

export function EmptyState(props: EmptyStateProps) {
	const { t } = useTranslation(["drive", "common"])
	const copy = props.variant === "empty" ? driveEmptyStateCopy(props.driveVariant) : null
	const Icon = copy?.icon ?? FolderClosedIcon

	return (
		// The testid is the stable "this listing settled empty" hook for tests: every variant renders
		// its own bespoke title/body copy here, so copy-based detection breaks on any surface but the
		// default one (and again on every future copy edit); the error variant is deliberately a
		// DIFFERENT id — an errored listing is not a settled-empty one.
		<Empty data-testid={props.variant === "empty" ? "listing-empty" : "listing-error"}>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon />
				</EmptyMedia>
				<EmptyTitle>{props.variant === "error" ? t("driveLoadError") : t(copy?.titleKey ?? "driveEmptyTitle")}</EmptyTitle>
				<EmptyDescription>
					{props.variant === "error" ? errorLabel(props.error) : t(copy?.bodyKey ?? "driveEmptyBody")}
				</EmptyDescription>
			</EmptyHeader>
			{props.variant === "error" ? (
				<EmptyContent>
					<Button
						variant="outline"
						onClick={props.onRetry}
					>
						{t("common:tryAgain")}
					</Button>
				</EmptyContent>
			) : props.action ? (
				<EmptyContent>
					<div className="flex items-center gap-2">{props.action}</div>
				</EmptyContent>
			) : null}
		</Empty>
	)
}
