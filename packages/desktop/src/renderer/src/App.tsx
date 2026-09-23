import { useEffect, useState } from 'react';
import { ToastProvider } from './components/Toasts';
import { LiveView } from './views/LiveView';
import { MainView } from './views/MainView';

type Route = { name: 'main' } | { name: 'live'; index: number };

function parseRoute(hash: string): Route {
  const m = /^#\/live\/(\d+)\/?$/.exec(hash);
  if (m) return { name: 'live', index: Number(m[1]) };
  return { name: 'main' };
}

/** Hash router: "#/" → main window, "#/live/<i>" → live control window. */
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

  return <ToastProvider>{route.name === 'live' ? <LiveView index={route.index} /> : <MainView />}</ToastProvider>;
}
