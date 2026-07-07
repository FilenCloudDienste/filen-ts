import { useTranslation } from "react-i18next"
import { FolderClosedIcon } from "lucide-react"
import { type ErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Discriminated on variant so an "error" render can never be constructed without its error/retry —
// the same two branches directory-listing.tsx's placeholder rendered inline, now shared with the
// real listing.
export type EmptyStateProps = { variant: "empty" } | { variant: "error"; error: ErrorDTO; onRetry: () => void }

export function EmptyState(props: EmptyStateProps) {
	const { t } = useTranslation(["drive", "common"])

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<FolderClosedIcon />
				</EmptyMedia>
				<EmptyTitle>{props.variant === "error" ? t("driveLoadError") : t("driveEmptyTitle")}</EmptyTitle>
				<EmptyDescription>{props.variant === "error" ? errorLabel(props.error) : t("driveEmptyBody")}</EmptyDescription>
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
			) : null}
		</Empty>
	)
}
