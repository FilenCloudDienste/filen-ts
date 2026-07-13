import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { Button } from "@/components/ui/button"

const FILEN_HOME_URL = "https://filen.io"
const REPORT_ABUSE_MAILTO = "mailto:abuse@filen.io"

// The shared shell for BOTH public-link routes — a slim, marketing-light chrome around whatever surface
// the link resolves to (invalid / password / file / directory). This page deliberately drops
// old-web's upsell sidebar: just a brand mark, a quiet sign-in link, one tasteful "Get Filen" CTA, and
// a one-line footer with the e2e tagline and a minimal report-abuse affordance. Fully responsive and
// theme-aware via the app's existing tokens (the ambient ThemeProvider resolves system default for an
// anonymous visitor, so nothing theme-specific is hardcoded here).
export function PublicLinkShell({ children }: { children: ReactNode }) {
	const { t } = useTranslation("publicLinks")

	return (
		<div className="flex min-h-svh flex-col bg-canvas text-foreground">
			<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-canvas/80 px-4 backdrop-blur-sm sm:px-6">
				<a
					href={FILEN_HOME_URL}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={t("homeLabel")}
					className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<Logo className="size-6 text-primary" />
					<span className="text-base font-semibold tracking-tight">Filen</span>
				</a>
				<div className="flex items-center gap-1 sm:gap-2">
					<Link
						to="/login"
						className="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						{t("signIn")}
					</Link>
					<Button
						render={
							<a
								href={FILEN_HOME_URL}
								target="_blank"
								rel="noopener noreferrer"
							/>
						}
						size="sm"
					>
						{t("getFilen")}
					</Button>
				</div>
			</header>

			<main className="flex w-full flex-1 flex-col">{children}</main>

			<footer className="flex shrink-0 flex-col items-center justify-center gap-1 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground sm:flex-row sm:gap-3">
				<span>{t("footerTagline")}</span>
				<span
					aria-hidden="true"
					className="hidden sm:inline"
				>
					·
				</span>
				<a
					href={REPORT_ABUSE_MAILTO}
					className="rounded-md underline underline-offset-4 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					{t("reportAbuse")}
				</a>
			</footer>
		</div>
	)
}
