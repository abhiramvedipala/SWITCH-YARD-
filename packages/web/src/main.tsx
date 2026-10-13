import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { consumeTokenFromHash } from './lib/api.js';
import './styles.css';
import './theme.css';

consumeTokenFromHash();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
