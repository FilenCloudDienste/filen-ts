import "@/polyfills"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"
import App from "@/App"
import { ThemeProvider } from "@/components/theme-provider"

const rootElement = document.getElementById("root")

if (!rootElement) {
	throw new Error("Root element not found")
}

createRoot(rootElement).render(
	<StrictMode>
		<ThemeProvider>
			<App />
		</ThemeProvider>
	</StrictMode>
)
