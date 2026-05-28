import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { registerServiceWorker } from './registerServiceWorker';
import { bootstrapSourceVault } from './lib/bootstrapSourceVault';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

registerServiceWorker();

// Load the ingested CFA curriculum into the local source vault on first run.
bootstrapSourceVault();
