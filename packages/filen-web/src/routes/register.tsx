import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { redirectIfAuthed } from "@/features/auth/lib/guard"
import { RegisterForm } from "@/features/auth/components/registerForm"
import { AuthCard } from "@/features/auth/components/authCard"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Unauthed page: a live session bounces straight to /drive. Same shared guard as /login — see
// guard.ts. Shares login.tsx's AuthCard shell; the real form (strength meter, referral capture,
// eligibility banner, check-your-email success state) lives in RegisterForm.
export const Route = createFileRoute("/register")({
	head: routeHead({ title: () => [i18n.t("auth:registerDocumentTitle")] }),
	beforeLoad: redirectIfAuthed,
	component: RegisterPage
})

function RegisterPage() {
	const { t } = useTranslation("auth")

	return (
		<AuthCard
			title={t("registerTitle")}
			subtitle={t("registerSubtitle")}
			footer={{ i18nKey: "alreadyHaveAccount", to: "/login" }}
		>
			<RegisterForm />
		</AuthCard>
	)
}
