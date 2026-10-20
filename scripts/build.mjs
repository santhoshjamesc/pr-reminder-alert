// Bundles the VS Code extension and the notification service with esbuild.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // node:sqlite is a Node built-in; vscode is provided by the extension host.
  external: ['vscode', 'node:sqlite'],
  // Bundled Google OAuth client (see src/extension/builtinGoogleClient.ts).
  define: {
    __PR_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.PR_REMINDER_GOOGLE_CLIENT_ID ?? ''),
    __PR_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.PR_REMINDER_GOOGLE_CLIENT_SECRET ?? ''),
    // Same value in the extension and service bundles; see src/shared/build.ts.
    __PR_BUILD_ID__: JSON.stringify(String(Date.now())),
  },
};

const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js' },
  { ...common, entryPoints: ['src/service/main.ts'], outfile: 'dist/service.js' },
  { ...common, entryPoints: ['src/tools/googleSignIn.ts'], outfile: 'dist/google-signin.js' },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log('[build] watching for changes...');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
