import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { AuthLegalLinks } from "@/features/auth/components/legalLinks"
import { useDismissBootSplash } from "@/lib/bootSplash"

// Cross-link between the two entry pages; its locale string wraps the link text in <a>.
interface AuthCardFooter {
	i18nKey: "dontHaveAccount" | "alreadyHaveAccount"
	to: "/login" | "/register"
}

// Page shell shared by the unauthed entry routes (login, register, reset).
function AuthCard({
	title,
	subtitle,
	footer,
	children
}: {
	title: string
	subtitle: string
	footer?: AuthCardFooter
	children: ReactNode
}) {
	const { t } = useTranslation("auth")

	useDismissBootSplash()

	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-canvas p-6 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<Logo className="size-10 text-primary" />
					<div className="flex flex-col gap-1">
						<CardTitle>{title}</CardTitle>
						<CardDescription>{subtitle}</CardDescription>
					</div>
				</CardHeader>
				<CardContent>{children}</CardContent>
				{footer ? (
					<CardFooter className="justify-center">
						<p className="text-sm text-muted-foreground">
							<Trans
								t={t}
								i18nKey={footer.i18nKey}
								components={{
									a: (
										<Link
											to={footer.to}
											className="text-foreground underline underline-offset-4"
										/>
									)
								}}
							/>
						</p>
					</CardFooter>
				) : null}
			</Card>
			<AuthLegalLinks />
		</div>
	)
}

export { AuthCard }
