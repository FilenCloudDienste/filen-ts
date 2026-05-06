import configPlugins from "@expo/config-plugins"

const { withAndroidManifest } = configPlugins

type ConfigPlugin = configPlugins.ConfigPlugin

const SERVICE_NAME = "app.notifee.core.ForegroundService"
const FOREGROUND_SERVICE_TYPE = "dataSync"

const withNotifeeForegroundServiceType: ConfigPlugin = config => {
	return withAndroidManifest(config, async config => {
		const application = config.modResults.manifest.application?.[0]

		if (!application) {
			throw new Error("withNotifeeForegroundServiceType: <application> not found")
		}

		application.service = application.service ?? []

		const existing = application.service.find(s => s.$["android:name"] === SERVICE_NAME)

		if (existing) {
			existing.$["android:foregroundServiceType"] = FOREGROUND_SERVICE_TYPE
		} else {
			application.service.push({
				$: {
					"android:name": SERVICE_NAME,
					"android:exported": "false",
					"android:foregroundServiceType": FOREGROUND_SERVICE_TYPE
				}
			})
		}

		return config
	})
}

export default withNotifeeForegroundServiceType
