import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { buttonVariants } from "@/components/ui/button"
import { usePublicVisitorSignedIn } from "@/features/publicLinks/queries/publicLink"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { ThirdPartyNoticesLink } from "@/features/settings/components/advanced/thirdPartyNoticesLink"
import { desktopPlatform } from "@/lib/desktop"
import { ReportAbuseButton } from "@/features/publicLinks/components/reportAbuseDialog"

const FILEN_HOME_URL = "https://filen.io"

// The shared shell for BOTH public-link routes — a slim, marketing-light chrome around whatever surface
// the link resolves to (invalid / password / file / directory). This page deliberately drops
// old-web's upsell sidebar: just a brand mark, a quiet sign-in link, one tasteful "Get Filen" CTA (for a
// signed-in visitor, a single way back to Cloud Drive instead), and a one-line footer with the e2e
// tagline, a report-abuse dialog and, quieter at its far end, the third party notices. Exactly
// one viewport tall with both bars pinned: only `main` scrolls, and a surface that fills it (a preview, a
// directory's list) sizes to it through its own min-h-0 chain. Theme-aware via the app's existing tokens (the
// ambient ThemeProvider resolves system default for an anonymous visitor, so nothing theme-specific is
// hardcoded here).
export function PublicLinkShell({ children }: { children: ReactNode }) {
	const { t } = useTranslation("publicLinks")
	const signedIn = usePublicVisitorSignedIn()

	useDismissBootSplash()

	return (
		<div className="flex h-svh flex-col overflow-hidden bg-canvas text-foreground">
			{/* Window chrome on desktop: below the Windows/Linux controls band, clear of the macOS lights. */}
			<header className="flex h-[calc(3.5rem+var(--window-inset-top))] shrink-0 items-center justify-between gap-3 border-b border-border px-4 pt-(--window-inset-top) pl-[max(1rem,var(--window-inset-left))] app-region-chrome sm:px-6 sm:pl-[max(1.5rem,var(--window-inset-left))]">
				<a
					href={FILEN_HOME_URL}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={t("homeLabel")}
					className="flex items-center gap-2 rounded-md focus-ring outline-none"
				>
					<Logo className="size-6 text-primary" />
					<span className="text-base font-semibold tracking-tight">Filen</span>
				</a>
				<div className="flex items-center gap-1 sm:gap-2">
					{/* A signed-in visitor already has Filen: the way back to their drive replaces both the
					    sign-in link and the marketing CTA. Nothing renders until the session answer is in. */}
					{signedIn.data === true ? (
						<Link
							to="/drive/$"
							params={{ _splat: "" }}
							className={buttonVariants({ size: "sm" })}
						>
							{t("openCloudDrive")}
						</Link>
					) : signedIn.data === false ? (
						<>
							<Link
								to="/login"
								className="rounded-md px-2 py-1 text-sm text-muted-foreground focus-ring transition-colors outline-none hover:text-foreground"
							>
								{t("signIn")}
							</Link>
							{/* Inside the desktop app the visitor already has Filen. */}
							{desktopPlatform() === undefined ? (
								<a
									href={FILEN_HOME_URL}
									target="_blank"
									rel="noopener noreferrer"
									className={buttonVariants({ size: "sm" })}
								>
									{t("getFilen")}
								</a>
							) : null}
						</>
					) : null}
				</div>
			</header>

			<main className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">{children}</main>

			<footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-t border-border px-4 py-2 text-xs text-muted-foreground sm:justify-between sm:px-6">
				<div className="flex flex-wrap items-center justify-center gap-x-2">
					<span>{t("footerTagline")}</span>
					<span
						aria-hidden="true"
						className="hidden sm:inline"
					>
						·
					</span>
					<ReportAbuseButton
						signedIn={signedIn.data === true}
						className="rounded-md underline underline-offset-4 focus-ring transition-colors outline-none hover:text-foreground"
					/>
				</div>
				<ThirdPartyNoticesLink className="rounded-md text-[0.6875rem] text-muted-foreground/70 focus-ring transition-colors outline-none hover:text-foreground hover:underline hover:underline-offset-4" />
			</footer>
		</div>
	)
}
