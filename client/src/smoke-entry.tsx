/* Smoke entry — mounts the real App so jsdom can exercise it. */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import App from './App';

const el = document.getElementById('root');
if (el) {
  const root = createRoot(el);
  root.render(createElement(App));
  (window as any).__vxRoot = root;
}
