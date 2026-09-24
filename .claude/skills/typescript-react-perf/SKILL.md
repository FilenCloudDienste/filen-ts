---
name: typescript-react-perf
description: >
    React and React Native UI performance rules for filen-mobile and filen-web: React Compiler
    (no manual memo), lists, gestures, images, state libraries and known RN pitfalls. Use when
    writing or reviewing React components or hooks.
---

# React / React Native Performance

## React Compiler (on in filen-mobile and filen-web)

- Don't add `memo`, `useMemo` or `useCallback`; the compiler memoizes, and lint (`react-hooks` v7, `preserve-manual-memoization: error`) rejects memoization it can't preserve.
- Exceptions: third-party APIs that need a stable reference, and reanimated shared-value writes and gesture builders, which go in module-scope functions (e.g. `applyContainerLayout` / `buildScaleMirror` in `src/components/ui/zoomableView.tsx`) so reanimated-blind compiler tools stay green.
- Never mutate props or hook arguments; copy instead.
- Stable keys from ids, never the array index.

## Libraries already in use

- Long lists: FlashList 2 on mobile (via `VirtualList`; 2.x has no `estimatedItemSize`), `@tanstack/react-virtual` on web. Never `ScrollView` + `.map()` for long lists.
- Mobile touch: gesture-handler based pressables (`PressableOpacity` / `PressableScale`), not core `Touchable*`.
- Mobile images: expo-image. Mobile styling: uniwind `className`.
- State: Zustand for UI state, TanStack Query for server data (mobile and web). Never `useEffect` + fetch + `useState`.
- Keyed lookups and membership tests: `Map` / `Set`, not arrays or objects with dynamic keys.

## Known RN pitfalls

- No reanimated `entering`/`exiting` layout animations on views inside FlashList rows: recycled cells pin them at stale coordinates on Android.
- Expo SharedObjects (expo-image-manipulator contexts, image refs): hold the receiver in a `const` across the `await`, then `.release()` it after the async settles, or decoded native bitmaps leak.
- Clean up every listener and subscription in the effect's return; cancel async work on unmount.
