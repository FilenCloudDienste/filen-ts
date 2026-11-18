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

// How long text on its way is waited for before the copy is given up.
export const COPY_TEXT_WAIT_MS = 10_000

// Text that did not come: its source had none to give, or took longer than COPY_TEXT_WAIT_MS.
class CopyTextUnavailable extends Error {
	override readonly name = "CopyTextUnavailable"
}

// Copies text that is still on its way (a worker's answer) within the click that asked for it: a browser that ends the
// click's activation at the first await (Safari) takes the write as a promise of the text, where it accepts one. Null,
// or nothing within COPY_TEXT_WAIT_MS, writes nothing and says `failedMessage`.
export async function copyTextLater(
	text: Promise<string | null>,
	messages: { readonly copied: string; readonly failed: string },
	waitMs = COPY_TEXT_WAIT_MS
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const arrived = Promise.race([
		text,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new CopyTextUnavailable("the text did not arrive"))
			}, waitMs)
		})
	])
		.then(value => {
			if (value === null) throw new CopyTextUnavailable("there was no text to copy")

			return value
		})
		.finally(() => {
			clearTimeout(timer)
		})

	try {
		if (typeof ClipboardItem === "function" && typeof navigator.clipboard.write === "function") {
			await navigator.clipboard.write([
				new ClipboardItem({ "text/plain": arrived.then(value => new Blob([value], { type: "text/plain" })) })
			])
		} else {
			await navigator.clipboard.writeText(await arrived)
		}

		toast.success(messages.copied)

		return true
	} catch (e) {
		toast.error(e instanceof CopyTextUnavailable ? messages.failed : errorLabel(e))

		return false
	}
}
