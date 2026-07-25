import { QueryClient } from '@tanstack/solid-query'

// Shared solid-query client (Task 0.1). Adopted incrementally as the read
// cache + optimistic-mutation layer, one surface at a time
// (archives/tags -> moments -> todos -> canvas -> chat). The existing 3s
// event poll (App.pollEvents) drives invalidation: when a sync event lands
// for a cached surface, call queryClient.invalidateQueries with its key.
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // The event poll keeps caches fresh, so we don't need aggressive
            // background refetching. Keep data warm for half a minute and
            // avoid refetch storms on tab focus.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
})

// Central registry of query keys so invalidation sites can't drift from the
// definition sites.
export const qk = {
    archives: ['archives'] as const,
    tags: ['tags'] as const,
}
