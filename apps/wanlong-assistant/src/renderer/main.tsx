import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveView } from '@avdm/emulator-shell/renderer/views/LiveView';
import { App } from './App';
import { ToastProvider } from './components/Toasts';
// Kept after the app imports (as before the shell refactor): page styles were tuned against this cascade order.
import '@avdm/emulator-shell/renderer/styles.css';

if (/Mac/i.test(navigator.userAgent)) document.documentElement.classList.add('platform-mac');

function PanelApp() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const live = /^#\/live\/(\d+)\/?$/.exec(hash);
  useEffect(() => { document.documentElement.dataset['route'] = live ? 'live' : 'automation'; }, [live]);
  return <ToastProvider>{live ? <LiveView index={Number(live[1])} /> : <App />}</ToastProvider>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><PanelApp /></StrictMode>);
