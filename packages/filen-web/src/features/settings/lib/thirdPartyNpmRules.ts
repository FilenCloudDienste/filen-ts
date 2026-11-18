// What the third-party notices take from the npm tree beyond what pnpm reports (scripts/generateThirdPartyNotices.ts,
// and its drift guard in thirdPartyNotices.test.ts).

// Installed for the app but shipped by no build: elkjs is mermaid's ELK layout, aliased to a stub in the Mermaid frame
// build (vite/mermaid-frame-plugin.ts: the layout is locked to dagre).
export const NPM_NOT_SHIPPED: ReadonlySet<string> = new Set(["elkjs"])

// SPDX ids for packages whose package.json names none, read from the license file they ship: khroma's is the MIT
// License ("Copyright (c) 2019-present Fabio Spampinato, Andrew Maney").
export const NPM_LICENSE_OVERRIDES: ReadonlyMap<string, string> = new Map([["khroma", "MIT"]])
