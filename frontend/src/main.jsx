import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './light-mode-depth.css'
import './modal-scroll-lock.css'
import './AtlasMutationGuard.js'
import './EmailRetirement.js'
import App from './App.jsx'
import { AtlasFeedbackProvider } from './AtlasFeedback.jsx'

const AtlasIntelligenceLayer = lazy(() => import('./AtlasIntelligenceLayer.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AtlasFeedbackProvider>
      <App />
      <Suspense fallback={null}>
        <AtlasIntelligenceLayer />
      </Suspense>
    </AtlasFeedbackProvider>
  </StrictMode>,
)
