// Runs before first paint, ahead of the bundle: puts the saved theme's class on <html> so the page
// never flashes the other theme while the app loads. The CSP allows no inline script, hence a file;
// ThemeProvider takes the class over once it mounts. Mirrors its "theme" key and "system" default.
;(function () {
	var dark = false

	try {
		var theme = localStorage.getItem("theme")

		// The previous web app on this origin kept the theme in a "theme" cookie. Taken over when nothing is saved
		// here yet (its values are THEME_SETTINGS in @filen/shared/theme), then expired: it would ride every request.
		if (theme !== "system" && theme !== "light" && theme !== "dark") {
			var cookie = /(?:^|;\s*)theme=(system|light|dark)(?:;|$)/.exec(document.cookie)

			if (cookie !== null) {
				theme = cookie[1]
				localStorage.setItem("theme", theme)
			}
		}

		if (/(?:^|;\s*)theme=/.test(document.cookie)) {
			document.cookie = "theme=; Max-Age=0; path=/"
		}

		dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)

		document.documentElement.classList.add(dark ? "dark" : "light")
	} catch (e) {
		// Storage blocked: the inline style in index.html still follows the OS appearance, and so does the tint.
		dark = window.matchMedia("(prefers-color-scheme: dark)").matches
	}

	// Browser chrome and the installed window's title bar take the shown theme's canvas, not the OS appearance.
	// Mirrors THEME_COLORS in src/providers/themeProvider.tsx.
	var themeColor = document.querySelector('meta[name="theme-color"]')

	if (themeColor !== null) {
		themeColor.setAttribute("content", dark ? "#070707" : "#e6e6e6")
	}
})()
