import * as Clipboard from "expo-clipboard"
import { run } from "@filen/shared"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

export async function copyToClipboard(text: string, successMessage: string, logTag: string, logMessage: string): Promise<void> {
	const result = await run(async () => {
		await Clipboard.setStringAsync(text)
	})

	if (!result.success) {
		logger.error(logTag, logMessage, { error: result.error })
		alerts.error(result.error)

		return
	}

	alerts.normal(successMessage)
}
