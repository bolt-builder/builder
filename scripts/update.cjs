#!/usr/bin/env node
/**
 * Cross-platform update script for Bolt (bolt.diy).
 * Pulls latest from main, installs deps, and optionally rebuilds.
 *
 * Usage:
 *   pnpm run update          # update from git (no build)
 *   pnpm run update -- --build   # update + rebuild for production
 */
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { resolve } = require('path');

const ROOT = resolve(__dirname, '..');
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

const args = process.argv.slice(2);
const doBuild = args.includes('--build');

console.log('\n🔄 Updating Bolt to latest version...\n');

// 1. Check we're in a git repo
if (!existsSync(resolve(ROOT, '.git'))) {
  console.error('❌ Not a git repository. Run this from a git-cloned project.');
  process.exit(1);
}

// 2. Check for uncommitted changes
try {
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();

  if (status) {
    console.log('⚠️  You have uncommitted changes:\n');
    console.log(status);
    console.log('\nStashing changes before pulling...');
    run('git stash push -m "auto-stash before update"');
    console.log('✅ Changes stashed\n');
  }
} catch {
  console.error('❌ git is not installed or not accessible.');
  process.exit(1);
}

// 3. Pull latest from main
try {
  console.log('📥 Pulling latest from main...');
  run('git pull origin main --rebase');
  console.log('✅ Code updated\n');
} catch (err) {
  console.error('❌ Failed to pull. You may have merge conflicts.');
  console.error('   Run: git stash pop (to restore your changes)');
  process.exit(1);
}

// 4. Install dependencies
console.log('📦 Installing dependencies...');
run('pnpm install --frozen-lockfile');
console.log('✅ Dependencies installed\n');

// 5. Build (only if --build flag is passed)
if (doBuild) {
  console.log('🔨 Building application...');
  run('pnpm build');
  console.log('✅ Build complete\n');
} else {
  console.log('⏭️  Skipping build (pass --build to rebuild for production)\n');
}

// 6. Show current version
try {
  const hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`✅ Updated to ${branch}@${hash}`);
  console.log('   Run: pnpm dev (development) or pnpm start (production)\n');
} catch {
  console.log('✅ Update complete\n');
}
