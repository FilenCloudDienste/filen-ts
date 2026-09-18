// The sessionStorage key the e2e harness hands a session blob over in. Its own module so bootSdk can
// drain the slot without importing the hooks module — that import would pull the whole test surface
// into the production graph, which the no-flag build grep (tests.yml) forbids.
export const SESSION_SLOT = "filen.e2e.session"
