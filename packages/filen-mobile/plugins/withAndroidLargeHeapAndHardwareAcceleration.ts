import configPlugins from "@expo/config-plugins"

const { withAndroidManifest } = configPlugins

type ConfigPlugin = configPlugins.ConfigPlugin

const withAndroidLargeHeapAndHardwareAcceleration: ConfigPlugin = config => {
	return withAndroidManifest(config, async config => {
		const application = config.modResults.manifest.application?.[0]

		if (application) {
			application.$["android:largeHeap"] = "true"
			application.$["android:hardwareAccelerated"] = "true"
		}

		const activity = config.modResults.manifest.application?.[0]?.activity?.[0]

		if (activity) {
			activity.$["android:hardwareAccelerated"] = "true"
		}

		return config
	})
}

export default withAndroidLargeHeapAndHardwareAcceleration
