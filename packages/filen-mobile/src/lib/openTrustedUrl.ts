import { Linking } from "react-native"
import { run } from "@filen/shared"
import logger from "@/lib/logger"
import alerts from "@/lib/alerts"

// Opens an app-authored https URL. Untrusted links go through useOpenExternalLink instead. No
// canOpenURL pre-check: every device handles https, and openURL rejects when nothing does. A real
// app-switch, so exempt from withSystemPresentation.
export async function openTrustedUrl(tag: string, url: string): Promise<void> {
	const result = await run(async () => {
		return await Linking.openURL(url)
	})

	if (!result.success) {
		logger.error(tag, "failed to open url", {
			url,
			error: result.error
		})
		alerts.error(result.error)
	}
}
