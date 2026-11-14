import type { PdfSecurityChoice, PdfSecurityRefusal } from "@filen/office/core/pdfedit/security"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PreviewKey } from "@/lib/i18n"

// The Protect requests from the page's side: the protection the next save writes, and unlocking owner rights. The
// session takes the engine's snapshot from each answer (dirty, the tools the author's restrictions allowed).

// What the next save writes; the reason it was refused, or null once chosen.
export async function chooseProtection(session: PdfEditSessionModel, choice: PdfSecurityChoice | null): Promise<PdfSecurityRefusal | null> {
	const answer = await session.engine.call("securitySet", { choice })

	if (!answer.ok) return answer.reason

	session.refresh(answer.state)

	return null
}

// Whether `password` is the owner password; the document has owner rights once it was.
export async function unlockOwnerRights(session: PdfEditSessionModel, password: string): Promise<boolean> {
	const answer = await session.engine.call("securityUnlock", { password })

	if (answer.ok) session.refresh(answer.state)

	return answer.ok
}

// What the user is told when a choice was refused.
export function refusalKey(reason: PdfSecurityRefusal): PreviewKey {
	switch (reason) {
		case "ownerRequired":
			return "previewPdfOwnerRestricted"
		case "openPasswordUnknown":
		case "notRc4":
			return "previewPdfSecurityUpgradeUnavailable"
		case "passwordRefused":
		case "emptyPassword":
			return "previewPdfSecurityRefused"
		case "samePasswords":
			return "previewPdfSecuritySame"
		case "unsupported":
		case "platform":
			return "previewPdfSecurityFailed"
	}
}
