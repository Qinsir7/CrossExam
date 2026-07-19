import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './AppV2.tsx'
import TransactionReviewApp from './App.tsx'

const RootApp = window.location.pathname.startsWith('/check/transaction') ? TransactionReviewApp : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
)
