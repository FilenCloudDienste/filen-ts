import { transformSync } from "@babel/core"

// Transform-level healthcheck (a post-bundle grep is a false-negative trap — the
// specifier is inlined away). Mirrors the exact preset/plugin combination
// vite.config.ts's `babel()` call uses, so a green run here is a real proxy for the
// app's build wiring, not just this script's own wiring.
const FIXTURE = `
import { useState } from "react"
export function Probe({ items }: { items: string[] }) {
  const [q] = useState("")
  const filtered = items.filter(i => i.includes(q))
  return <ul>{filtered.map(i => <li key={i}>{i}</li>)}</ul>
}`

const out = transformSync(FIXTURE, {
	filename: "probe.tsx",
	// @babel/preset-typescript@8 removed `isTSX`/`allExtensions` (now unconditionally
	// strips TS syntax based on the filename, no JSX-parsing opinion attached). Unlike
	// the real vite.config.ts pipeline — where @rolldown/plugin-babel auto-configures the
	// parser for .tsx files — a bare @babel/core call has no JSX syntax support unless a
	// plugin declares it, so @babel/plugin-syntax-jsx is required here (verified: without
	// it, `<li key={i}>` parses as an ambiguous TS construct and throws).
	presets: ["@babel/preset-typescript"],
	plugins: ["@babel/plugin-syntax-jsx", ["babel-plugin-react-compiler", {}]]
})

if (out?.code?.includes("react/compiler-runtime") !== true) {
	console.error("React Compiler DID NOT transform the fixture — wiring is broken")
	process.exit(1)
}

console.log("react-compiler: OK")
