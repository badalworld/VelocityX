import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/* Dissolve the pre-paint boot screen as soon as the shell has painted. */
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.style.transition = 'opacity 520ms ease';
  boot.style.opacity = '0';
  window.setTimeout(() => boot.remove(), 560);
});
