import { useEffect, useState } from "react"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import type { MermaidOutcome } from "@/features/preview/lib/mermaidFrame"
import { MermaidScope } from "@/features/preview/lib/mermaidScope"
import { mermaidSourceVerdict } from "@/features/preview/lib/mermaidSource.logic"

export type MermaidDiagramState =
	| { readonly status: "waiting" }
	| { readonly status: "pending" }
	| { readonly status: "refused" }
	| { readonly status: "tooComplex" }
	| { readonly status: "failed" }
	| { readonly status: "svg"; readonly svg: Blob }

// A viewer's diagram scope, released when the viewer goes.
export function useMermaidScope(): MermaidScope {
	const [scope] = useState(() => new MermaidScope())

	useEffect(
		() => () => {
			scope.release()
		},
		[scope]
	)

	return scope
}

// A diagram's source as the frame draws it in the app's theme, once `enabled` (until then "waiting", its source not even
// looked at). Without a scope it waits for good.
export function useMermaidDiagram(scope: MermaidScope | null, text: string, enabled: boolean): MermaidDiagramState {
	const { theme } = useTheme()
	const mermaidTheme = resolveTheme(theme) === "dark" ? "dark" : "default"
	// Judged only once wanted: a document's far and unasked fences cost nothing.
	const verdict = enabled ? mermaidSourceVerdict(text) : null
	const source = verdict?.kind === "render" ? verdict.source : null
	const key = `${mermaidTheme}\0${source ?? ""}`
	const [result, setResult] = useState<{ readonly key: string; readonly outcome: MermaidOutcome } | null>(null)

	useEffect(() => {
		if (!enabled || scope === null || source === null) {
			return
		}

		let live = true

		void scope.host.render(source, mermaidTheme).then(outcome => {
			if (live) setResult({ key, outcome })
		})

		return () => {
			live = false
		}
	}, [enabled, scope, source, mermaidTheme, key])

	if (verdict === null) {
		return { status: "waiting" }
	}

	if (verdict.kind !== "render") {
		return { status: verdict.kind }
	}

	if (scope === null) {
		return { status: "waiting" }
	}

	if (result?.key !== key) {
		return { status: "pending" }
	}

	return result.outcome.kind === "svg" ? { status: "svg", svg: result.outcome.svg } : { status: result.outcome.kind }
}
