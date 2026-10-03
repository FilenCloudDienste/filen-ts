// Runs before first paint, ahead of the bundle: puts the saved theme's class on <html> so the page
// never flashes the other theme while the app loads. The CSP allows no inline script, hence a file;
// ThemeProvider takes the class over once it mounts. Mirrors its "theme" key and "system" default.
;(function () {
	try {
		var theme = localStorage.getItem("theme")
		var dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)

		document.documentElement.classList.add(dark ? "dark" : "light")
	} catch (e) {
		// Storage blocked: the inline style in index.html still follows the OS appearance.
	}
})()
