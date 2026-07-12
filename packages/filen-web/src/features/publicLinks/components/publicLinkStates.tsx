import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FileWarningIcon, RotateCwIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"

// The shell's `main` is a flex column; every terminal state (loading / invalid / error) centers itself
// in that space. Kept as a plain wrapper so each state reads as a small centered card in the app's
// existing visual language.
export function CenteredSurface({ children }: { children: ReactNode }) {
	return <div className="flex flex-1 items-center justify-center p-6">{children}</div>
}

// Resolving spinner — the brief window before a link's metadata lands.
export function PublicLinkLoading() {
	const { t } = useTranslation("publicLinks")

	return (
		<CenteredSurface>
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner />
				<span>{t("opening")}</span>
			</div>
		</CenteredSurface>
	)
}

// "This link is unavailable" — the single terminal surface for a bad uuid, a bad/short key, a
// not-found, or any resolution failure that isn't a password prompt (old-web parity: it deliberately
// does not distinguish "doesn't exist" from "expired").
export function PublicLinkInvalid() {
	const { t } = useTranslation("publicLinks")

	return (
		<CenteredSurface>
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
					<FileWarningIcon className="size-6" />
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="text-lg font-semibold">{t("unavailableTitle")}</h1>
					<p className="text-sm text-muted-foreground">{t("unavailableBody")}</p>
				</div>
				<Link
					to="/"
					className="text-sm text-foreground underline underline-offset-4"
				>
					{t("back")}
				</Link>
			</div>
		</CenteredSurface>
	)
}

// A retryable failure — the F6a retry affordance carried onto the public routes: the same "something
// broke, try again" recovery the authed preview/listing surfaces offer, wired to the query's refetch.
export function PublicLinkError({ onRetry }: { onRetry: () => void }) {
	const { t } = useTranslation("publicLinks")

	return (
		<CenteredSurface>
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
					<FileWarningIcon className="size-6" />
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="text-lg font-semibold">{t("unavailableTitle")}</h1>
					<p className="text-sm text-muted-foreground">{t("unavailableBody")}</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={onRetry}
				>
					<RotateCwIcon data-icon="inline-start" />
					{t("retry")}
				</Button>
			</div>
		</CenteredSurface>
	)
}
