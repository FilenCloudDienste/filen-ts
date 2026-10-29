import { type ConfigPlugin, withGradleProperties } from "expo/config-plugins"

const withGradleMemory: ConfigPlugin = config => {
	return withGradleProperties(config, config => {
		// Replace the template's entry, otherwise gradle.properties carries the key twice.
		config.modResults = config.modResults.filter(item => item.type !== "property" || item.key !== "org.gradle.jvmargs")

		config.modResults.push({
			type: "property",
			key: "org.gradle.jvmargs",
			// UTF-8 pinned: a non-UTF-8 shell locale makes the JVM default to ASCII, and boost's tarball then fails to expand.
			value: "-Xmx6g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8"
		})

		return config
	})
}

export default withGradleMemory
