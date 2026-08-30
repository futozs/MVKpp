import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

/*
 * Service worker regisztrálása. Ettől ajánlja fel az Android a
 * „Kezdőképernyőre" telepítést; a fejlesztői szerveren kihagyjuk, hogy a
 * gyorsítótár ne zavarja a hot reloadot.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* telepíthetőség nélkül is működik minden */
    })
  })
}
