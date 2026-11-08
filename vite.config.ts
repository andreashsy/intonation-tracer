// Vite picks this up automatically. Kept dependency-free (no `defineConfig`
// import) so it type-checks even before `npm install`.
export default {
  worker: { format: 'es' as const },
  build: { target: 'es2022' },
};
