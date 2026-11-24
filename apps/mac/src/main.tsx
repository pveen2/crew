import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crew/ui/styles.css';
import { App } from './App';
import { connect } from './store';
import './app.css';

// Narrow the transport policy to the server chosen in the main process before loading team data.
const origin = window.crewHost?.serverOrigin;
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws://localhost:* https://127.0.0.1:* wss://127.0.0.1:* https://localhost:* wss://localhost:*" +
  (origin ? ' ' + origin + ' ' + origin.replace(/^https:/, 'wss:') : '');
document.head.append(policy);

void connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
