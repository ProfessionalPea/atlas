import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './light-mode-depth.css'
import './modal-scroll-lock.css'
import App from './App.jsx'
import { AtlasFeedbackProvider } from './AtlasFeedback.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AtlasFeedbackProvider>
      <App />
    </AtlasFeedbackProvider>
  </StrictMode>,
)
