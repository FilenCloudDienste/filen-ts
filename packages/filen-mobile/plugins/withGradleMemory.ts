import { ConfigPlugin } from "@expo/config-plugins"
import { withGradleProperties } from "@expo/config-plugins/build/plugins/android-plugins"

const withGradleMemory: ConfigPlugin = config => {
	return withGradleProperties(config, config => {
		// Replace the template's entry, otherwise gradle.properties carries the key twice.
		config.modResults = config.modResults.filter(item => item.type !== "property" || item.key !== "org.gradle.jvmargs")

		config.modResults.push({
			type: "property",
			key: "org.gradle.jvmargs",
			value: "-Xmx6g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError"
		})

		return config
	})
}

export default withGradleMemory
