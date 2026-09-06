/**
 * frontend/next.config.mjs
 * ------------------------------------------------------------------
 * Next.js 14 configuration.
 *
 * The important part is `rewrites()`: every browser request to /api/*
 * is proxied to the Express backend. That means the frontend only ever
 * uses same-origin relative URLs, which works
 *   • locally (localhost:3000 -> localhost:5000)
 *   • behind a dev preview / reverse proxy / different hostname
 *   • in production behind any domain
 *
 * Point the backend somewhere else with BACKEND_URL:
 *   BACKEND_URL=http://192.168.1.50:5000 npm run dev
 */

const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
