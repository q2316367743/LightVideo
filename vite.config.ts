import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

/**
 * base 必须是 './'：插件窗口用 plugin://<id>/ui/index.html 加载，
 * 以 / 开头的资源路径会指到包根，dashou-plugin build 会直接报错拦下。
 * 端口与 src-dashou/plugin.json 的 build.devUrl 对应。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5175,
    watch: { ignored: ['**/src-dashou/dashou-dist/**', '**/src-dashou/ui/**'] }
  }
})
