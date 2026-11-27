import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FileWarningIcon, RotateCwIcon } from "lucide-react"
import { LoadingState } from "@/components/loadingState"
import { Button } from "@/components/ui/button"
import { desktopPlatform } from "@/lib/desktop"

// The shell's `main` is a flex column; every terminal state (loading / invalid / error) centers itself
// in that space. Kept as a plain wrapper so each state reads as a small centered card in the app's
// existing visual language.
export function CenteredSurface({ children }: { children: ReactNode }) {
	return <div className="flex flex-1 items-center justify-center p-6">{children}</div>
}

// Resolving spinner — the brief window before a link's metadata lands.
export function PublicLinkLoading() {
	return <LoadingState size="lg" />
}

// The "link is unavailable" card; each terminal state supplies only its trailing action.
function UnavailableSurface({ title, body, action }: { title: string; body: string; action: ReactNode }) {
	return (
		<CenteredSurface>
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
					<FileWarningIcon className="size-6" />
				</div>
				<div className="flex flex-col gap-1">
					<h1 className="text-lg font-semibold">{title}</h1>
					<p className="text-sm text-muted-foreground">{body}</p>
				</div>
				{action}
			</div>
		</CenteredSurface>
	)
}

// "This link is unavailable" — the single terminal surface for a bad uuid, a bad/short key, a
// not-found, or any resolution failure that isn't a password prompt (old-web parity: it deliberately
// does not distinguish "doesn't exist" from "expired"). `incomplete`: the link was cut off at or
// before the '#', so the key is missing or malformed and only the full link helps.
export function PublicLinkInvalid({ reason = "invalid" }: { reason?: "invalid" | "incomplete" }) {
	const { t } = useTranslation("publicLinks")

	return (
		<UnavailableSurface
			title={reason === "incomplete" ? t("incompleteTitle") : t("unavailableTitle")}
			body={reason === "incomplete" ? t("incompleteBody") : t("unavailableBody")}
			action={
				<Link
					to="/"
					className="text-sm text-foreground underline underline-offset-4"
				>
					{t("back")}
				</Link>
			}
		/>
	)
}

// A retryable failure — the preview surfaces' retry affordance carried onto the public routes: the same "something
// broke, try again" recovery the authed preview/listing surfaces offer, wired to the query's refetch.
export function PublicLinkError({ onRetry }: { onRetry: () => void }) {
	const { t } = useTranslation("publicLinks")

	return (
		<UnavailableSurface
			title={t("loadErrorTitle")}
			body={t("loadErrorBody")}
			action={
				<Button
					variant="outline"
					size="sm"
					onClick={onRetry}
				>
					<RotateCwIcon data-icon="inline-start" />
					{t("retry")}
				</Button>
			}
		/>
	)
}

// The file or directory zip cannot be held in memory. The way out (another browser or the desktop app) is
// advice for a browser only. `compact`: one truncating line, the whole text in its title (a slim bar). Mounted with its
// text, so an alert, which is announced on mount.
export function DownloadTooLargeNote({ message, compact = false }: { message: string; compact?: boolean }) {
	const { t } = useTranslation("publicLinks")
	const text = desktopPlatform() === undefined ? `${message} ${t("downloadTooLargeAdvice")}` : message

	return compact ? (
		<span
			role="alert"
			className="truncate text-xs text-destructive"
			title={text}
		>
			{text}
		</span>
	) : (
		<p
			role="alert"
			className="text-sm text-destructive"
		>
			{text}
		</p>
	)
}
