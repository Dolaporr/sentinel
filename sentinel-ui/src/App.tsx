import { useState, useEffect } from 'react';
import { LandingPage } from './components/LandingPage';
import { ReplayViewer } from './components/ReplayViewer';

export function App() {
  const [route, setRoute] = useState<'landing' | 'replay'>(() => {
    if (typeof window === 'undefined') return 'landing';
    const path = window.location.pathname.replace(/\/+$/, '');
    const hash = window.location.hash;
    const search = window.location.search;
    if (path === '/replay' || hash === '#/replay' || search.includes('view=replay')) {
      return 'replay';
    }
    return 'landing';
  });

  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.replace(/\/+$/, '');
      const hash = window.location.hash;
      const search = window.location.search;
      if (path === '/replay' || hash === '#/replay' || search.includes('view=replay')) {
        setRoute('replay');
      } else {
        setRoute('landing');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // index.html carries the landing page's title so scrapers, which do not run
  // this code, see it. The replay view keeps its own once React is running.
  useEffect(() => {
    document.title = route === 'replay'
      ? 'SENTINEL // Dual-Agent Telemetry Replay'
      : 'Sentinel — a spend governor for AI agents';
  }, [route]);

  const navigate = (to: 'landing' | 'replay') => {
    const targetPath = to === 'replay' ? '/replay' : '/';
    window.history.pushState({}, '', targetPath);
    setRoute(to);
    window.scrollTo(0, 0);
  };

  if (route === 'replay') {
    return <ReplayViewer onNavigateLanding={() => navigate('landing')} />;
  }

  return <LandingPage onNavigateReplay={() => navigate('replay')} />;
}
