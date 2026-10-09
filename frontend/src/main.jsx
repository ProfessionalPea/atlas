import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './light-mode-depth.css'
import './modal-scroll-lock.css'
import './theme-transition.css'
import './ThemeTransitionGuard.js'
import './AtlasMutationGuard.js'
import './EmailRetirement.js'
import App from './App.jsx'
import { AtlasFeedbackProvider } from './AtlasFeedback.jsx'
import VideoLibraryEditor from './VideoLibraryEditor.jsx'

const AtlasIntelligenceLayer = lazy(() => import('./AtlasIntelligenceLayer.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AtlasFeedbackProvider>
      <App />
      <Suspense fallback={null}>
        <AtlasIntelligenceLayer />
      </Suspense>
      <VideoLibraryEditor />
    </AtlasFeedbackProvider>
  </StrictMode>,
)
