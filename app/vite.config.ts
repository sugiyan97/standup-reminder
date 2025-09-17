import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
  },
  
  // Tauri uses a non-standard import for environment variables
  // Tell Vite about it
  envPrefix: ["VITE_", "TAURI_"],
  
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_PLATFORM == "windows" ? "chrome105" : "safari13",
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
