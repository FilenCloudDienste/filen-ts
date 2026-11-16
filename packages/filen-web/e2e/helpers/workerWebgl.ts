// Whether this engine's CI runner gives a worker WebGL2 on a transferred OffscreenCanvas (w7-webgl-probe.spec.ts checks
// it on every run). Where false, the 3D and DXF legs assert the needs-WebGL card and View source instead of reading
// pixels back.
export const WORKER_WEBGL: Record<"chromium" | "firefox" | "webkit", boolean> = {
	chromium: true,
	firefox: true,
	webkit: true
}
