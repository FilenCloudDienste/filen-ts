// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config")
const { withUniwindConfig } = require("uniwind/metro")

/** @type {import('expo/metro-config').MetroConfig} */
const defaultConfig = getDefaultConfig(__dirname)

/** @type {import('expo/metro-config').MetroConfig} */
const config = {
	...defaultConfig,
	resolver: {
		...defaultConfig.resolver,
		extraNodeModules: {
			buffer: require.resolve("@craftzdog/react-native-buffer"),
			crypto: require.resolve("react-native-quick-crypto"),
			stream: require.resolve("readable-stream"),
			path: require.resolve("path-browserify")
		},
		unstable_enablePackageExports: true,
		enableGlobalPackages: true,
		unstable_conditionNames: ["browser", "require", "react-native", "default"]
	}
}

module.exports = withUniwindConfig(config, {
	cssEntryFile: "./src/global.css",
	dtsFile: "./src/uniwind-types.d.ts"
})
