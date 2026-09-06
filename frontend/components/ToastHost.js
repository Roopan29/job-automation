/**
 * components/ToastHost.js
 * ------------------------------------------------------------------
 * Single react-hot-toast <Toaster /> for the whole app.
 *
 * Kept in its own file so app/layout.js can stay a Server Component –
 * <Toaster /> is a client component and cannot be rendered directly
 * from server code.
 */

'use client';

import { Toaster } from 'react-hot-toast';

export default function ToastHost() {
  return (
    <Toaster
      position="bottom-right"
      gutter={10}
      toastOptions={{
        duration: 4000,
        style: {
          background: '#0f172a',
          color: '#f1f5f9',
          fontSize: '13px',
          maxWidth: '420px',
          borderRadius: '10px',
        },
        success: { iconTheme: { primary: '#22c55e', secondary: '#0f172a' } },
        error: { iconTheme: { primary: '#ef4444', secondary: '#0f172a' }, duration: 6000 },
      }}
    />
  );
}
