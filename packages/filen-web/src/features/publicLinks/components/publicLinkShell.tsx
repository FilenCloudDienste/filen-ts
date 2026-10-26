import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { buttonVariants } from "@/components/ui/button"
import { usePublicVisitorSignedIn } from "@/features/publicLinks/queries/publicLink"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { ThirdPartyNoticesLink } from "@/features/settings/components/advanced/thirdPartyNoticesLink"
import { desktopPlatform } from "@/lib/desktop"

const FILEN_HOME_URL = "https://filen.io"
const REPORT_ABUSE_MAILTO = "mailto:abuse@filen.io"

// The shared shell for BOTH public-link routes — a slim, marketing-light chrome around whatever surface
// the link resolves to (invalid / password / file / directory). This page deliberately drops
// old-web's upsell sidebar: just a brand mark, a quiet sign-in link, one tasteful "Get Filen" CTA (for a
// signed-in visitor, a single way back to Cloud Drive instead), and a one-line footer with the e2e
// tagline, a minimal report-abuse affordance and the open source licenses. Fully responsive and
// theme-aware via the app's existing tokens (the ambient ThemeProvider resolves system default for an
// anonymous visitor, so nothing theme-specific is hardcoded here).
export function PublicLinkShell({ children }: { children: ReactNode }) {
	const { t } = useTranslation("publicLinks")
	const signedIn = usePublicVisitorSignedIn()

	useDismissBootSplash()

	return (
		<div className="flex min-h-svh flex-col bg-canvas text-foreground">
			{/* Window chrome on desktop: below the Windows/Linux controls band, clear of the macOS lights. */}
			<header className="sticky top-0 z-10 flex h-[calc(3.5rem+var(--window-inset-top))] shrink-0 items-center justify-between gap-3 border-b border-border bg-canvas/80 px-4 pt-(--window-inset-top) pl-[max(1rem,var(--window-inset-left))] backdrop-blur-sm app-region-chrome sm:px-6 sm:pl-[max(1.5rem,var(--window-inset-left))]">
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
					className="rounded-md underline underline-offset-4 focus-ring transition-colors outline-none hover:text-foreground"
				>
					{t("reportAbuse")}
				</a>
				<span
					aria-hidden="true"
					className="hidden sm:inline"
				>
					·
				</span>
				<ThirdPartyNoticesLink className="rounded-md underline underline-offset-4 focus-ring transition-colors outline-none hover:text-foreground" />
			</footer>
		</div>
	)
}
