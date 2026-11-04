package io.filen.net

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FilenNetModule : Module() {
	override fun definition() = ModuleDefinition {
		Name("FilenNet")

		// Synchronous so JS can run it right before it creates an SDK client (src/lib/auth.ts).
		Function("initTls") {
			val context = appContext.reactContext ?: return@Function false

			FilenTls.ensureInitialized(context)
		}

		Function("tlsReady") {
			FilenTls.isInitialized
		}
	}
}
