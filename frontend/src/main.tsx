import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// First: it may swap in a saved setup before the rest of the app reads its settings.
import './config/profiles'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
