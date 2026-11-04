import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

async function bootstrap(): Promise<void> {
  if (import.meta.env.DEV) {
    const { installMock } = await import('./dev/mock')
    installMock()
  }
  createApp(App).mount('#app')
}

void bootstrap()
