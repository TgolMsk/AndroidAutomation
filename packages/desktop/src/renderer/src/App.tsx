import { useEffect, useState } from 'react';
import { ToastProvider } from './components/Toasts';
import { AutomationView } from './views/AutomationView';
import { LiveView } from './views/LiveView';
import { MainView } from './views/MainView';

type Route = { name: 'main' } | { name: 'automation' } | { name: 'live'; index: number };

function parseRoute(hash: string): Route {
  if (/^#\/automation\/?$/.test(hash)) return { name: 'automation' };
  const m = /^#\/live\/(\d+)\/?$/.exec(hash);
  if (m) return { name: 'live', index: Number(m[1]) };
  return { name: 'main' };
}

/** Hash router: "#/" → instances, "#/automation" → game tools, "#/live/<i>" → live control window. */
export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset['route'] = route.name;
  }, [route.name]);

  return (
    <ToastProvider>
      {route.name === 'live' ? (
        <LiveView index={route.index} />
      ) : route.name === 'automation' ? (
        <AutomationView onBack={() => { window.location.hash = '#/'; }} />
      ) : (
        <MainView />
      )}
    </ToastProvider>
  );
}
