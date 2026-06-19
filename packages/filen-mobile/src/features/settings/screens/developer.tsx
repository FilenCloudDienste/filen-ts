import { Fragment } from "react"
import { Platform } from "react-native"
import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import { run } from "@filen/utils"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import SafeAreaView from "@/components/ui/safeAreaView"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Group } from "@/components/ui/settingsGroup"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { shareTmpFile } from "@/lib/share"
import diagnostics from "@/features/settings/diagnostics"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import logger from "@/lib/logger"

// Dev-only debug menu — a scratchpad of buttons that exercise app behaviour during development
// (fire banners, force crashes, write logs, poke native dialogs). Reached from More → Developer,
// which only builds the row in __DEV__; this screen also guards itself (defense-in-depth) so a stray
// router.push("/developer") or deep link can never surface it in a production build.
//
// Strings are hardcoded English on purpose: the screen never ships, so keeping it out of the typed
// i18n catalog + CI translation pipeline is intentional, not an oversight.

// Deliberately long + multi-line so the error banner grows taller than the notifier's default hide
// distance — the exact case that used to leave a red strip stuck at the top (see lib/alerts.tsx).
const LONG_ERROR_MESSAGE =
	"This is a deliberately long error message for testing the error banner. It wraps across many lines so the banner grows taller than the notifier's default hide distance, which is the scenario that previously left a red strip stuck at the top of the screen. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."

async function exportLogs(): Promise<void> {
	const result = await runWithLoading(async () => {
		return await diagnostics.prepareLogsExport()
	})

	if (!result.success) {
		alerts.error(result.error)

		return
	}

	if (result.data === "no-logs") {
		alerts.normal("No logs to export")

		return
	}

	await shareTmpFile({
		uri: result.data.uri,
		name: result.data.name,
		mimeType: "application/zip",
		cleanup: result.data.cleanup
	})
}

function writeSampleLogs(): void {
	logger.debug("developer", "Sample debug log", { source: "developer menu" })
	logger.info("developer", "Sample info log", { source: "developer menu" })
	logger.warn("developer", "Sample warn log", { source: "developer menu" })
	logger.error("developer", "Sample error log", { source: "developer menu" })

	alerts.normal("Wrote 4 sample log entries")
}

async function testAlertPrompt(): Promise<void> {
	const result = await run(async () => {
		return await prompts.alert({
			title: "Alert prompt",
			message: "This is a two-button alert."
		})
	})

	if (result.success) {
		alerts.normal(result.data.cancelled ? "Cancelled" : "Confirmed")
	}
}

async function testConfirm3Prompt(): Promise<void> {
	const result = await run(async () => {
		return await prompts.confirm3({
			title: "Three-button prompt",
			message: "Pick one of the three options.",
			primaryText: "Primary",
			destructiveText: "Destructive"
		})
	})

	if (result.success) {
		alerts.normal(`Chose: ${result.data}`)
	}
}

async function testInputPrompt(): Promise<void> {
	const result = await run(async () => {
		return await prompts.input({
			title: "Text input prompt",
			message: "Type something and confirm.",
			placeholder: "Anything…"
		})
	})

	if (!result.success || result.data.cancelled) {
		return
	}

	if (result.data.type === "string") {
		alerts.normal(`Got: ${result.data.value}`)
	}
}

async function showEnvironmentInfo(): Promise<void> {
	const hermes = Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal)
	const isDev = (globalThis as { __DEV__?: boolean }).__DEV__ === true

	await run(async () => {
		await prompts.info({
			title: "Environment",
			message: [`Platform: ${Platform.OS} (${String(Platform.Version)})`, `Hermes: ${hermes}`, `__DEV__: ${isDev}`].join("\n")
		})
	})
}

function Developer() {
	const navigation = useNavigation()

	// Defense-in-depth: the More-tab row is already __DEV__-gated, but guard here too so a deep link /
	// programmatic push can never render the debug surface in a production build. globalThis read (not
	// bare __DEV__) keeps this safe to evaluate under vitest.
	if ((globalThis as { __DEV__?: boolean }).__DEV__ !== true) {
		return null
	}

	return (
		<Fragment>
			<SettingsHeader
				title="Developer"
				icon="close"
				onDismiss={() => {
					navigation.getParent()?.goBack()
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<SettingsScrollView>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "alert-circle-outline",
								title: "Error banner (short)",
								onPress: () => {
									alerts.error("Short test error")
								}
							},
							{
								icon: "alert-circle-outline",
								title: "Error banner (long)",
								subTitle: "Multi-line — repros the stuck-banner case",
								onPress: () => {
									alerts.error(LONG_ERROR_MESSAGE)
								}
							},
							{
								icon: "checkmark-circle-outline",
								title: "Success toast",
								onPress: () => {
									alerts.normal("Test toast")
								}
							}
						]}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "flame-outline",
								title: "Throw uncaught error",
								subTitle: "Exercises the global error handler",
								onPress: () => {
									throw new Error("Developer menu: test uncaught error")
								}
							},
							{
								icon: "git-branch-outline",
								title: "Trigger unhandled rejection",
								subTitle: "Exercises the promise rejection tracker",
								onPress: () => {
									void Promise.reject(new Error("Developer menu: test unhandled rejection"))
								}
							},
							{
								icon: "create-outline",
								title: "Write sample logs",
								subTitle: "debug · info · warn · error",
								onPress: () => {
									writeSampleLogs()
								}
							},
							{
								icon: "list-outline",
								title: "View logs",
								onPress: () => {
									router.push("/logViewer")
								}
							},
							{
								icon: "document-text-outline",
								title: "Export logs",
								onPress: () => {
									exportLogs()
								}
							}
						]}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "chatbox-ellipses-outline",
								title: "Alert prompt",
								onPress: () => {
									testAlertPrompt()
								}
							},
							{
								icon: "options-outline",
								title: "Three-button prompt",
								onPress: () => {
									testConfirm3Prompt()
								}
							},
							{
								icon: "pencil-outline",
								title: "Text input prompt",
								onPress: () => {
									testInputPrompt()
								}
							}
						]}
					/>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "information-circle-outline",
								title: "Environment info",
								onPress: () => {
									showEnvironmentInfo()
								}
							}
						]}
					/>
				</SettingsScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Developer
