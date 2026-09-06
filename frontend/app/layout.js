/**
 * app/layout.js
 * ------------------------------------------------------------------
 * Root layout: dark-navy sidebar on the left, white content area,
 * global toast host, and the AppProvider that holds shared state.
 *
 * This file is a Server Component; everything interactive lives in the
 * "use client" children (Sidebar, pages, components).
 */

import './globals.css';
import { AppProvider } from '@/context/AppContext';
import Sidebar from '@/components/Sidebar';
import ToastHost from '@/components/ToastHost';

export const metadata = {
  title: 'JobBot 🤖 — Personal Job Application Automation',
  description:
    'Parse your resume, scrape jobs, match them to your skills, auto-apply and track every application in one local dashboard.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>
          <div className="min-h-screen bg-slate-50">
            <Sidebar />
            {/* 240px sidebar offset */}
            <main className="page-shell">
              <div className="page-container">{children}</div>
            </main>
          </div>
          <ToastHost />
        </AppProvider>
      </body>
    </html>
  );
}
