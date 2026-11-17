// Whether this engine's CI runner gives a worker WebGL2 on a transferred OffscreenCanvas (w7-webgl-probe.spec.ts checks
// it on every run). Where false, the 3D and DXF legs assert the needs-WebGL card and View source instead of reading
// pixels back. Headless Firefox and WebKit on the Linux runners give a worker no WebGL2 context.
export const WORKER_WEBGL: Record<"chromium" | "firefox" | "webkit", boolean> = {
	chromium: true,
	firefox: false,
	webkit: false
}
