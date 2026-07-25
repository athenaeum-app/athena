import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// A dedicated config for unit/component tests. It deliberately omits the PWA
// and Tailwind plugins from vite.config.ts, they are irrelevant under test
// and slow the run down. Only vite-plugin-solid is needed to transform JSX.
export default defineConfig({
    plugins: [solid()],
    resolve: {
        // Use Solid's browser/development export conditions so reactivity
        // works under jsdom (per the Solid testing guide).
        conditions: ['development', 'browser'],
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./vitest.setup.ts'],
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
})
