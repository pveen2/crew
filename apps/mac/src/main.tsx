import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crew/ui/styles.css';
import { App } from './App';
import { SharePage } from './components/SharePage';
import { connect, getState } from './store';
import { applyTouchIcon } from './touchIcon';
import './app.css';

// A share link (/s/<token>) is a read-only page for anyone: no conductor connection.
const shareToken = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1];
if (shareToken) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SharePage token={shareToken} />
    </StrictMode>,
  );
} else {
  start();
}

function start(): void {
  void connect();

  // The web app on a phone: size the app to what is visible, so the on-screen
  // keyboard pushes the composer up instead of covering it.
  const vv = window.visualViewport;
  if (!window.crewHost && vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
      document.documentElement.style.setProperty('--app-top', `${vv.offsetTop}px`);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }
  if (!window.crewHost) applyTouchIcon(getState().touchIcon);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
