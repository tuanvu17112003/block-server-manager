import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/press-start-2p';
import App from './App';
import './index.css';
import { initializeBackendConfig } from './backend/config';

async function bootstrap() {
  await initializeBackendConfig();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
