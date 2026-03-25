module.exports = function (api) {
	api.cache(true)

	return {
		presets: ["babel-preset-expo"],
		plugins: [
			"react-native-worklets/plugin",
			...(process.env.NODE_ENV === "production" ? ["transform-remove-console"] : [])
		]
	}
}
