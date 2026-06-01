import configPlugins from "@expo/config-plugins"
import fs from "node:fs"
import path from "node:path"

const { withAndroidManifest, withDangerousMod } = configPlugins

type AndroidLocaleConfigOptions = {
	locales: string[]
}

function generateLocaleConfigXml(locales: string[]): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
${locales.map(l => `	<locale android:name="${l}"/>`).join("\n")}
</locale-config>
`
}

/**
 * Expo Config Plugin to enable per-app language support on Android.
 *
 * This plugin does two things:
 * 1. Adds the `android:localeConfig="@xml/locales_config"` attribute
 *    to the <application> tag in the generated AndroidManifest.xml.
 * 2. Generates `res/xml/locales_config.xml` during prebuild from the
 *    `locales` option passed in app.config.ts (the SUPPORTED_LANGUAGES array),
 *    so the locale list stays driven by the single source of truth rather than
 *    a separate on-disk folder. Defaults to ["en"] if none are provided.
 *
 * With this plugin, Android 13+ devices can show the app in the system
 * per-app language settings.
 */
const withAndroidLocaleConfig: configPlugins.ConfigPlugin<AndroidLocaleConfigOptions> = (config, options) => {
	const locales = options.locales && options.locales.length > 0 ? options.locales : ["en"]

	// 1) Add android:localeConfig attribute to <application>
	config = withAndroidManifest(config, cfg => {
		const application = cfg.modResults.manifest.application?.[0]

		if (application) {
			application.$["android:localeConfig"] = "@xml/locales_config"
		}

		return cfg
	})

	// 2) Write res/xml/locales_config.xml during prebuild
	config = withDangerousMod(config, [
		"android",
		async cfg => {
			const xml = generateLocaleConfigXml(locales)
			const resXmlDir = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml")

			await fs.promises.mkdir(resXmlDir, {
				recursive: true
			})

			const outPath = path.join(resXmlDir, "locales_config.xml")

			await fs.promises.writeFile(outPath, xml, "utf8")

			return cfg
		}
	])

	return config
}

export default withAndroidLocaleConfig
