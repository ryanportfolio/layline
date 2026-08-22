/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three.js ships untranspiled ESM examples; let Next transpile them.
  transpilePackages: ['three'],
  // Rewrite barrel imports to direct module paths so the client graph only
  // carries the entries actually used.
  experimental: {
    optimizePackageImports: ['@react-three/drei'],
  },
};

export default nextConfig;
