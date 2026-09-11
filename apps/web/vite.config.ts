import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
	},
	build: {
		rollupOptions: {
			output: {
				// Split the graph stack out of the app chunk (#2): React Flow +
				// dagre together dwarf the chat UI and pushed the single bundle
				// past vite's 500 kB warning line. Both chunks load in parallel
				// from the same module graph (no lazy route to hang them on —
				// the app is one tabbed page), so startup cost is unchanged;
				// the browser just fetches two cacheable units instead of one
				// monolith.
				manualChunks(id: string) {
					if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id) || /[\\/]node_modules[\\/]@dagrejs[\\/]/.test(id)) {
						return "graph-vendor";
					}
					return undefined;
				},
			},
		},
	},
});
