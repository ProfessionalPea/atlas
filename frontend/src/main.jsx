import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './AtlasMutationGuard.js'
import './EmailRetirement.js'
import App from './App.jsx'
import AtlasIntelligenceLayer from './AtlasIntelligenceLayer.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <AtlasIntelligenceLayer />
  </StrictMode>,
)
