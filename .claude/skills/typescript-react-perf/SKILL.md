---
name: typescript-react-perf
description: >
    Use when writing/reviewing TypeScript, React, or React Native code. Enforces
    zero-waste patterns: monomorphic shapes, Map/Set for O(1) lookups, pre-allocated arrays,
    no hidden class mutations. React: let React Compiler handle memoization — do NOT add
    manual memo/useCallback/useMemo unless absolutely necessary. No inline objects in JSX,
    stable keys. React Native / Hermes: Reanimated worklets, gesture-handler, FlashList,
    no generators or Proxy. Check project's existing libs first.
---

# High-Performance TypeScript / React / React Native

## Core Philosophy

- Allocations are expensive — every object, array, closure costs GC time
- Hot paths are sacred — zero-waste in code that runs frequently
- Use what the project already has — never introduce duplicate libraries
- **Let the React Compiler do its job** — it auto-memoizes better than humans

---

## 1. Engine Optimization

### Keep object shapes monomorphic

```typescript
// ❌ Polymorphic — JIT deoptimizes
function process(obj: { x: number } | { x: string }) {
	return obj.x
}

// ✅ Monomorphic — direct property access
function processNum(obj: { x: number }) {
	return obj.x
}
```

### Never change object shapes after creation

```typescript
// ❌ Hidden class changes
const obj: any = {}
obj.x = 1
obj.y = 2

// ✅ Define all properties upfront
const obj = { x: 1, y: 2 }
```

---

## 2. Memory & Allocation

### Pre-allocate, don't grow

```typescript
// ❌ Array grows repeatedly
const results: string[] = []
for (const item of items) results.push(transform(item))

// ✅ Pre-allocate exact size
const results = new Array<string>(items.length)
for (let i = 0; i < items.length; i++) results[i] = transform(items[i]!)
```

### Avoid closures in hot loops

```typescript
// ❌ Closure allocated every iteration
items.forEach((item, i) => {
	results[i] = process(item, context)
})

// ✅ for loop, no closure
for (let i = 0; i < items.length; i++) results[i] = process(items[i]!, context)
```

---

## 3. Data Structures

| Use case                   | Use                           | Never use                     |
| -------------------------- | ----------------------------- | ----------------------------- |
| Key-value, frequent lookup | `Map<K,V>`                    | Plain object for dynamic keys |
| Membership test            | `Set<T>`                      | `Array.includes()`            |
| Numeric data, typed        | `Float64Array` / `Int32Array` | `number[]`                    |
| FIFO queue                 | Circular buffer / deque       | `Array.shift()` — O(n)        |

---

## 4. Async & Concurrency

```typescript
// ❌ Sequential
const a = await fetchA()
const b = await fetchB()

// ✅ Parallel
const [a, b] = await Promise.all([fetchA(), fetchB()])
```

Use `Promise.allSettled` when partial failure is acceptable.

---

## 5. React Performance — Let the Compiler Work

### React Compiler handles memoization — DO NOT add manual memo/useCallback/useMemo

This project uses **React Compiler** (`react-compiler` ESLint plugin enforced). The compiler
automatically memoizes components, callbacks, and computed values. Manual memoization
conflicts with the compiler and causes "Compilation skipped because existing memoization
could not be preserved" errors.

```typescript
// ❌ DO NOT — manual memoization conflicts with React Compiler
const ExpensiveList = memo(({ items }: { items: Item[] }) => {
	const sorted = useMemo(() => [...items].sort(compare), [items])
	const handleClick = useCallback((id: string) => dispatch({ type: "SELECT", id }), [dispatch])
	return <ul>{sorted.map(item => <ListItem key={item.id} item={item} onClick={handleClick} />)}</ul>
})

// ✅ DO — plain code, let the compiler auto-memoize
function ExpensiveList({ items }: { items: Item[] }) {
	const sorted = [...items].sort(compare)
	const handleClick = (id: string) => dispatch({ type: "SELECT", id })
	return <ul>{sorted.map(item => <ListItem key={item.id} item={item} onClick={handleClick} />)}</ul>
}
```

### When manual memoization IS needed (rare)

Only use manual memoization when the React Compiler **cannot** handle the case:

1. **Module-scope functions** that the compiler doesn't analyze (not React components/hooks)
2. **Reanimated worklets** — the compiler doesn't understand `"worklet"` directives
3. **Third-party libraries** that explicitly require stable references (e.g., gesture handler configs)
4. **Truly expensive computations** where profiling proves the compiler's auto-memoization is insufficient

When you must use manual memoization, prefer extracting logic to module-scope functions
(invisible to the compiler) rather than fighting it with `useMemo`/`useCallback`:

```typescript
// ✅ Module-scope function — compiler doesn't analyze, no conflict
function buildGesture(sv: SharedValues, callbacks: Callbacks) {
	return Gesture.Pinch()
		.onStart(() => { "worklet"; /* ... */ })
		.onUpdate(e => { "worklet"; /* ... */ })
}

// Inside component — just call it
function ZoomableView() {
	const gesture = buildGesture(sharedValues, callbacks)
	return <GestureDetector gesture={gesture}>...</GestureDetector>
}
```

### Avoid mutating props — compiler enforces this

```typescript
// ❌ Compiler error: "This value cannot be modified"
function Component({ items }: { items: Item[] }) {
	items.push(newItem) // Mutating prop!
}

// ✅ Create a local copy
function Component({ items }: { items: Item[] }) {
	const allItems = [...items, newItem]
}
```

### Keys — stable and unique, never index

```typescript
// ❌ items.map((item, i) => <Item key={i} {...item} />)
// ✅ items.map(item => <Item key={item.id} {...item} />)
```

### No inline objects/arrays in JSX (still matters)

Even with the compiler, inline objects create new references that the compiler may
not optimize in all cases. Prefer module-level constants:

```typescript
// ⚠️ May cause extra work for the compiler
<Component style={{ margin: 0 }} options={["a", "b"]} />

// ✅ Module-level constants — zero cost
const STYLE = { margin: 0 } as const
const OPTIONS = ["a", "b"] as const
<Component style={STYLE} options={OPTIONS} />
```

### Virtualize large lists (web/desktop)

For web and Electron apps, virtualize lists with 100+ items. Check which library the project uses (`react-window`, `@tanstack/react-virtual`, etc.) before adding one.

### Lazy-load heavy components (web/desktop)

```typescript
const HeavyChart = lazy(() => import("./HeavyChart"))

<Suspense fallback={<Spinner />}>
	<HeavyChart />
</Suspense>
```

### State — use what the project uses

- This project uses **Zustand** for UI state, **TanStack Query** for server state across all packages
- Never `useEffect` + `fetch` + `useState` — use TanStack Query
- Split state by update frequency

### Context — never put high-frequency data in a single context

```typescript
// ❌ Every consumer re-renders on ANY change
const AppContext = createContext({ user, theme, cart, notifications })

// ✅ Split by update frequency
const UserContext = createContext<User | null>(null)
const CartContext = createContext<CartState>(emptyCart)
```

---

## 6. React Native / Hermes

Hermes pre-compiles JS to bytecode. No full JIT. Monomorphism matters even more. Minimize JS thread work.

### Animations — Reanimated worklets (project uses reanimated 4.x)

```typescript
// ✅ Worklets run on UI thread — zero JS thread cost
const translateX = useSharedValue(0)
const animatedStyle = useAnimatedStyle(() => {
	"worklet"

	return { transform: [{ translateX: translateX.value }] }
})
translateX.value = withSpring(100, {
	damping: 15,
	stiffness: 150
})

// ❌ JS-driven Animated.Value — drops frames
// ❌ setState in scroll/gesture handlers
```

### Gestures — gesture-handler (project uses it)

Always use `react-native-gesture-handler` for interactive elements during scroll/animation. `TouchableOpacity` from core runs on JS thread.

### Lists — FlashList (project uses @shopify/flash-list)

```typescript
// ✅ Plain function — React Compiler auto-memoizes renderItem
function ItemRow({ item }: { item: Item }) {
	return <View>...</View>
}

<FlashList
	data={items}
	renderItem={({ item }) => <ItemRow item={item} />}
	estimatedItemSize={72}
	keyExtractor={item => item.id}
/>
```

Never use `ScrollView` + `.map()` for more than ~20 items.

### Images — expo-image (project uses it)

Always set explicit `width` and `height`. Use `cachePolicy`.

### Styling — tailwindcss + uniwind (project uses it)

Use className strings via uniwind. For dynamic styles that depend on props/state,
just compute them inline — the React Compiler will memoize automatically.

### Hermes-specific — always apply

```typescript
// ❌ Generators — slow on Hermes
function* generateIds() {
	yield 1
}
// ✅ Plain array
function getIds() {
	return [1, 2]
}

// ❌ Proxy — very slow on Hermes
const tracked = new Proxy(obj, handler)
// ✅ Explicit methods

// ❌ Spread in hot paths — allocates
const merged = { ...defaults, ...overrides }
// ✅ Object.assign for hot paths
const result = Object.assign({} as Config, defaults, overrides)
```

### Memory — clean up everything

```typescript
useEffect(() => {
	const sub = AppState.addEventListener("change", handleAppState)

	return () => sub.remove()
}, [])
```

Cancel async ops on unmount. Remove all event listeners.

---

## 7. Patterns to Avoid

- `delete obj.key` — changes hidden class, use `obj.key = undefined` or Map
- `eval`, `new Function` — prevents optimization
- `Array.from(set).filter(...)` — iterate directly instead
- Regex in hot path — pre-compile at module level
- `try/catch` in tight loops — extract to wrapper function
- Optional chaining in hot paths — validate shape once at boundary
- `memo()`, `useMemo()`, `useCallback()` — let React Compiler handle it unless profiling proves otherwise
