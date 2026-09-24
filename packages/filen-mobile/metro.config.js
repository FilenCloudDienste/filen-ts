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
		// Metro also watches with this list. Argent flows and screen recordings (this package's .argent and
		// the repo root's) must not fast-refresh the app: a refresh under an open iOS context menu crashes it.
		blockList: [...[defaultConfig.resolver.blockList ?? []].flat(), /(?:^|[\\/])\.argent(?:[\\/]|$)/],
		extraNodeModules: {
			crypto: require.resolve("react-native-quick-crypto"),
			stream: require.resolve("readable-stream"),
			path: require.resolve("path-browserify")
		}
	}
}

module.exports = withUniwindConfig(config, {
	cssEntryFile: "./src/global.css",
	dtsFile: "./src/uniwind-types.d.ts"
})
