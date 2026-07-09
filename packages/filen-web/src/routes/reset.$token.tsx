import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { Logo } from "@/components/shell/logo"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResetForm } from "@/features/auth/components/resetForm"

// Unauthed page: a live session bounces straight to /drive. Same shared guard as /login and
// /register — see guard.ts. The reset link carries only a token, no email — the form itself asks for
// it (see reset-form.tsx).
export const Route = createFileRoute("/reset/$token")({
	beforeLoad: redirectIfAuthed,
	component: ResetPage
})

function ResetPage() {
	const { t } = useTranslation("auth")
	const { token } = Route.useParams()

	return (
		<div className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="justify-items-center gap-3 text-center">
					<Logo className="size-10 text-primary" />
					<div className="flex flex-col gap-1">
						<CardTitle>{t("resetTitle")}</CardTitle>
						<CardDescription>{t("resetBody")}</CardDescription>
					</div>
				</CardHeader>
				<CardContent>
					<ResetForm token={token} />
				</CardContent>
			</Card>
		</div>
	)
}
