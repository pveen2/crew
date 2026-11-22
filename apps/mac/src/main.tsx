import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crew/ui/styles.css';
import { App } from './App';
import { connect } from './store';
import './app.css';

void connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
