import { createFileRoute, Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/lib/auth/guard"
import { Logo } from "@/components/shell/logo"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

// Placeholder registration surface — the real form (strength meter, referral capture, eligibility
// banner) is built separately. Exists now so /login's "Sign up" link has a real, typed route to
// reach, staged the same way /login itself was before its real form landed. Same shared
// unauthed-page guard as /login.
export const Route = createFileRoute("/register")({
	beforeLoad: redirectIfAuthed,
	component: RegisterPage
})

function RegisterPage() {
	const { t } = useTranslation("auth")
	const { t: tCommon } = useTranslation()

	return (
		<div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<Logo className="size-10 text-primary" />
					<div className="flex flex-col gap-1">
						<CardTitle>{t("registerTitle")}</CardTitle>
						<CardDescription>{t("registerSubtitle")}</CardDescription>
					</div>
				</CardHeader>
				<CardContent>
					<p className="text-center text-sm text-muted-foreground">{tCommon("comingSoon")}</p>
				</CardContent>
				<CardFooter className="justify-center">
					<p className="text-sm text-muted-foreground">
						<Trans
							t={t}
							i18nKey="alreadyHaveAccount"
							components={{
								a: (
									<Link
										to="/login"
										className="text-foreground underline underline-offset-4"
									/>
								)
							}}
						/>
					</p>
				</CardFooter>
			</Card>
		</div>
	)
}
