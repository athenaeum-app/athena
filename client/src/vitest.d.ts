// Pull in jest-dom's matcher type augmentations (toBeInTheDocument, etc.) so
// `tsc --noEmit` sees them on vitest's Assertion type.
//
// The runtime import lives in ../vitest.setup.ts, but that file sits outside
// this project's `include: ["src"]`, so its `declare module 'vitest'`
// augmentation is invisible to the typechecker without this reference.
import '@testing-library/jest-dom/vitest'
