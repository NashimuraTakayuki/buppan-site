import { defineConfig } from 'vite'

export default defineConfig({
  // ビルド成果物の出力先（Netlifyの publish ディレクトリと一致させる）
  build: {
    outDir: 'dist',
  },
})
