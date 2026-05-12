import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('recharts') || id.includes('d3-')) return 'recharts';
          if (id.includes('lucide-react')) return 'lucide';
          if (id.includes('dompurify')) return 'dompurify';
        }
      }
    }
  }
})
