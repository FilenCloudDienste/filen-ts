import { ConfigPlugin } from "@expo/config-plugins"
import { withGradleProperties } from "@expo/config-plugins/build/plugins/android-plugins"

type AndroidArchitecturesOptions = {
	architectures?: string
}

const withAndroidArchitectures: ConfigPlugin<AndroidArchitecturesOptions> = (config, options = {}) => {
	const architectures = options.architectures || "arm64-v8a,x86_64"

	return withGradleProperties(config, config => {
		config.modResults = config.modResults.filter(item => item.type !== "property" || item.key !== "reactNativeArchitectures")

		config.modResults.push({
			type: "property",
			key: "reactNativeArchitectures",
			value: architectures
		})

		return config
	})
}

export default withAndroidArchitectures
