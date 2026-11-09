// Runs before first paint, ahead of the bundle: puts the saved theme's class on <html> so the page
// never flashes the other theme while the app loads. The CSP allows no inline script, hence a file;
// ThemeProvider takes the class over once it mounts. Mirrors its "theme" key and "system" default.
;(function () {
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

		var dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)

		document.documentElement.classList.add(dark ? "dark" : "light")
	} catch (e) {
		// Storage blocked: the inline style in index.html still follows the OS appearance.
	}
})()
