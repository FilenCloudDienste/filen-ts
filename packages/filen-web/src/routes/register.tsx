import { createFileRoute, Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/lib/auth/guard"
import { Logo } from "@/components/shell/logo"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { RegisterForm } from "@/components/auth/register-form"

// Unauthed page: a live session bounces straight to /drive. Same shared guard as /login — see
// guard.ts. Mirrors login.tsx's Card shell; the real form (strength meter, referral capture,
// eligibility banner, check-your-email success state) lives in RegisterForm.
export const Route = createFileRoute("/register")({
	beforeLoad: redirectIfAuthed,
	component: RegisterPage
})

function RegisterPage() {
	const { t } = useTranslation("auth")

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
					<RegisterForm />
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
