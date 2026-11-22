import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // @crew/ui is source-only and imports React itself: keep one copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 5317, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
