import JSZip from "jszip"
import { Platform } from "react-native"
import Constants from "expo-constants"
import * as FileSystem from "expo-file-system"
import logger from "@/lib/logger"
import { newTmpFile } from "@/lib/tmp"
import i18n from "@/lib/i18n"

export type PreparedLogsExport =
	| {
			uri: string
			name: string
			cleanup: () => void
	  }
	| "no-logs"

// Non-sensitive environment header bundled alongside the logs so a report is self-describing.
// Deliberately contains NO user data — just app/build/OS/locale/disk figures.
function buildDeviceInfo(): Record<string, unknown> {
	return {
		generatedAt: new Date().toISOString(),
		appVersion: Constants.expoConfig?.version ?? Constants["nativeAppVersion"] ?? "unknown",
		buildVersion: Constants["nativeBuildVersion"] ?? "unknown",
		platform: Platform.OS,
		osVersion: String(Platform.Version),
		locale: i18n.language,
		availableDiskSpaceBytes: FileSystem.Paths.availableDiskSpace,
		totalDiskSpaceBytes: FileSystem.Paths.totalDiskSpace
	}
}

const diagnostics = {
	/**
	 * Bundles the rotating NDJSON log files plus a non-sensitive device-info header into a tmp zip and
	 * returns its uri/name (+ a cleanup) for the caller to hand to the OS share sheet. Returns
	 * "no-logs" when there is nothing to export. Does NOT share — the caller runs this prep under the
	 * loading overlay and opens the share sheet AFTER it dismisses, so the overlay can't cover the
	 * native share sheet (mirrors the GDPR / master-keys export flows). The UI owns the consent prompt
	 * (logs may contain file/dir names) and the success/empty toasts; this stays silent.
	 */
	async prepareLogsExport(): Promise<PreparedLogsExport> {
		// Persist anything still buffered so the export reflects the latest state.
		logger.flushNow()

		const files = logger.listLogFiles()

		if (files.length === 0) {
			return "no-logs"
		}

		const zip = new JSZip()

		zip.file("device-info.json", JSON.stringify(buildDeviceInfo(), null, 2))

		for (const file of files) {
			try {
				zip.file(file.name, file.bytesSync())
			} catch {
				// Skip a file that vanished or can't be read; the rest still export.
			}
		}

		const buffer = await zip.generateAsync({
			type: "uint8array"
		})

		const tmp = newTmpFile(`filen-logs-${Date.now()}.zip`)

		if (tmp.exists) {
			tmp.delete()
		}

		tmp.write(buffer)

		return {
			uri: tmp.uri,
			name: tmp.name,
			cleanup: () => {
				if (tmp.exists) {
					tmp.delete()
				}
			}
		}
	}
}

export default diagnostics
