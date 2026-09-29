import { toast } from "sonner"
import { errorLabel } from "@/lib/i18n/errorLabel"

// Resolves whether the write landed, for callers that show their own copied state.
export async function copyText(text: string, successMessage: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		toast.success(successMessage)

		return true
	} catch (e) {
		toast.error(errorLabel(e))

		return false
	}
}
