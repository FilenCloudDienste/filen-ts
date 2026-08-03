import { useTranslation } from "react-i18next"
import { FILEN_PRIVACY_URL, FILEN_TERMS_URL } from "@/lib/externalUrls"

// Unauthed-screen footer. The authed equivalent is settings → Advanced → About (same two URLs, one
// const module). target="_blank" + rel="noopener noreferrer" matches every other external link here;
// inside an Electron BrowserWindow that already opens the OS browser, so no desktop bridge is needed.
// Wraps rather than overflows: translated labels run much longer than the English pair.
function AuthLegalLinks() {
	const { t } = useTranslation("auth")

	return (
		<p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<a
				href={FILEN_TERMS_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="rounded-md underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
			>
				{t("legalTerms")}
			</a>
			<a
				href={FILEN_PRIVACY_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="rounded-md underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
			>
				{t("legalPrivacy")}
			</a>
		</p>
	)
}

export { AuthLegalLinks }
