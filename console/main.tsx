import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { App } from './App';

const rootElement = document.getElementById('console-root');
if (!rootElement) {
  throw new Error('Missing #console-root mount element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
