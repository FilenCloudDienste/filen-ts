import { createFileRoute, Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { Logo } from "@/components/shell/logo"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { LoginForm } from "@/features/auth/components/loginForm"

// Unauthed page: a live session bounces straight to /drive. The shared guard awaits boot — which
// includes session resume — before reading auth state, so the check is race-free.
export const Route = createFileRoute("/login")({
	beforeLoad: redirectIfAuthed,
	component: LoginPage
})

function LoginPage() {
	const { t } = useTranslation("auth")

	return (
		<div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<Logo className="size-10 text-primary" />
					<div className="flex flex-col gap-1">
						<CardTitle>{t("loginTitle")}</CardTitle>
						<CardDescription>{t("loginSubtitle")}</CardDescription>
					</div>
				</CardHeader>
				<CardContent>
					<LoginForm />
				</CardContent>
				<CardFooter className="justify-center">
					<p className="text-sm text-muted-foreground">
						<Trans
							t={t}
							i18nKey="dontHaveAccount"
							components={{
								a: (
									<Link
										to="/register"
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
