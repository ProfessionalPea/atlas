import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AtlasIntelligenceUI from './AtlasIntelligenceUI.jsx'
import AtlasNavAnchorShim from './AtlasNavAnchorShim.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <AtlasNavAnchorShim />
    <AtlasIntelligenceUI />
  </StrictMode>,
)
