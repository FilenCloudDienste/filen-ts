module.exports = function (api) {
	api.cache(true)

	return {
		presets: ["babel-preset-expo"],
		plugins: [
			"react-native-worklets/plugin",
			// In production strip console.log/info/debug/trace (dev noise — keeps the prod log lean),
			// but KEEP console.warn/console.error via `exclude`: those MUST survive to reach the
			// diagnostic-logger tee (src/lib/polyfills/console.ts), which records them to disk. Removing
			// the `exclude` (or stripping error/warn) would silently disable warn/error capture in
			// production. The logger separately gates debug/info at runtime in prod (see src/global.ts).
			...(process.env.NODE_ENV === "production" ? [["transform-remove-console", { exclude: ["error", "warn"] }]] : [])
		]
	}
}
