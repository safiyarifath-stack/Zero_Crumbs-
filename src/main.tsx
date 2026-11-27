import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeTheme } from './utils/theme.ts';

initializeTheme();

// Case A Tier 1: Global Google Maps Platform quota / auth error detector
if (typeof window !== 'undefined') {
  const win = window as Window & { gm_authFailure?: () => void };
  const prevAuthFailure = win.gm_authFailure;
  win.gm_authFailure = () => {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    if (typeof prevAuthFailure === 'function') {
      prevAuthFailure();
    }
  };

  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : ''))
      .join(' ');
    if (
      msg.includes('OverQuotaMapError') ||
      msg.includes('QuotaExceededError')
    ) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }
    origConsoleError.apply(console, args);
  };
}

createRoot(document.getElementById('root')!).render(<App />);

