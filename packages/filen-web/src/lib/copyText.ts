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

// Copies text that is still on its way (a worker's answer) within the click that asked for it: a browser that ends the
// click's activation at the first await (Safari) takes the write as a promise of the text, where it accepts one.
export async function copyTextLater(text: Promise<string>, successMessage: string): Promise<boolean> {
	try {
		if (typeof ClipboardItem === "function" && typeof navigator.clipboard.write === "function") {
			await navigator.clipboard.write([
				new ClipboardItem({ "text/plain": text.then(value => new Blob([value], { type: "text/plain" })) })
			])
		} else {
			await navigator.clipboard.writeText(await text)
		}

		toast.success(successMessage)

		return true
	} catch (e) {
		toast.error(errorLabel(e))

		return false
	}
}
