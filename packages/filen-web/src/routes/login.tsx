import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Logo } from "@/components/shell/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

// Placeholder sign-in surface. The real authentication flow (login + 2FA, wired to the SDK worker's
// `login`) lands later — this establishes the design language and the field layout the
// real form will grow into. Controls are disabled and clearly captioned, not fake-interactive.
export const Route = createFileRoute("/login")({ component: LoginPage })

function LoginPage() {
	const { t } = useTranslation()

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
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="email">{t("loginEmail")}</FieldLabel>
							<Input
								id="email"
								type="email"
								autoComplete="off"
								placeholder="you@example.com"
								disabled
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="password">{t("loginPassword")}</FieldLabel>
							<Input
								id="password"
								type="password"
								placeholder="••••••••"
								disabled
							/>
						</Field>
					</FieldGroup>
				</CardContent>
				<CardFooter className="flex-col gap-3">
					<Button
						className="w-full"
						disabled
					>
						{t("loginContinue")}
					</Button>
					<p className="text-xs text-muted-foreground">{t("loginPlaceholderNote")}</p>
				</CardFooter>
			</Card>
		</div>
	)
}
