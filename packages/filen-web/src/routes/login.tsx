import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { LoginForm } from "@/features/auth/components/loginForm"
import { AuthCard } from "@/features/auth/components/authCard"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"
import { readSessionEndedNote } from "@/lib/sessionEndedNote"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"

// Unauthed page: a live session bounces straight to /drive. The shared guard awaits boot — which
// includes session resume — before reading auth state, so the check is race-free.
export const Route = createFileRoute("/login")({
	head: routeHead({ title: () => [i18n.t("auth:loginDocumentTitle")] }),
	beforeLoad: redirectIfAuthed,
	component: LoginPage
})

function LoginPage() {
	const { t } = useTranslation("auth")
	// Read once: the app signed out because the server ended the session (lib/sessionEndedNote.ts).
	const [sessionEnded] = useState(readSessionEndedNote)

	return (
		<AuthCard
			title={t("loginTitle")}
			subtitle={t("loginSubtitle")}
			footer={{ i18nKey: "dontHaveAccount", to: "/register" }}
		>
			{sessionEnded ? (
				<div
					role="status"
					className="mb-6"
				>
					<DesktopCallout tone="info">{t("loginSessionEnded")}</DesktopCallout>
				</div>
			) : null}
			<LoginForm />
		</AuthCard>
	)
}
