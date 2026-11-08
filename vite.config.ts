// Vite picks this up automatically. Kept dependency-free (no `defineConfig`
// import) so it type-checks even before `npm install`.
export default {
  // Relative base: the built site works at https://<user>.github.io/<repo>/ whatever
  // the repo is called, and also at a domain root or custom domain. Asset and worker
  // URLs are emitted relative to the page/module that loads them.
  base: './',
  worker: { format: 'es' as const },
  build: { target: 'es2022' },
};
