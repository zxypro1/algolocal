'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Ad-hoc sign the macOS bundle as soon as electron-builder has assembled it.
 *
 * Why this exists
 * ---------------
 * When no Developer ID certificate is available, the release workflow sets
 * CSC_IDENTITY_AUTO_DISCOVERY=false. That makes electron-builder's isSignAllowed()
 * return false and skip macOS signing altogether — including the afterSign hook,
 * which is why this runs from afterPack instead.
 *
 * Skipping is not the same as shipping something unsigned. The prebuilt Electron
 * binary arrives with a linker ad-hoc signature, and electron-builder then renames
 * the executable, swaps in our Info.plist and adds resources. The inherited
 * signature no longer describes the bundle, so it is not absent — it is broken:
 *
 *   codesign --verify  ->  code has no resources but signature indicates they must be present
 *   spctl -a -t exec   ->  notarization indicates this code has been revoked
 *
 * On macOS 15 (Sequoia) and later, "revoked" is the hard path: the system reports
 * malware and moves the app to the Trash, and the user has no override for it.
 * Re-signing ad-hoc so the signature actually matches the bundle downgrades that
 * verdict to a plain "rejected" — still unnotarized, but now the user can allow it
 * from System Settings > Privacy & Security.
 *
 * This is a mitigation, not a cure. Only a paid Apple Developer ID plus notarization
 * removes the warning entirely. When such a certificate is configured, electron-builder
 * signs the bundle again right after this hook and replaces the ad-hoc signature, so
 * this hook is harmless in that case and deliberately does not try to detect it.
 */
module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`afterPack: expected a bundle at ${appPath}, found none`);
  }

  const entitlements = path.join(__dirname, 'entitlements.mac.plist');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString().trim();

  // codesign refuses to sign files carrying extended attributes.
  try {
    run('xattr', ['-cr', appPath]);
  } catch {
    // No xattrs to strip is fine.
  }

  console.log(`  • ad-hoc signing ${path.basename(appPath)}`);
  run('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    '--options', 'runtime',
    '--entitlements', entitlements,
    '--timestamp=none',
    appPath,
  ]);

  // A broken signature is worse than no signature, so never let one ship silently.
  try {
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    const detail = (error.stderr || error.stdout || '').toString().trim();
    throw new Error(`afterPack: ad-hoc signature failed verification: ${detail}`);
  }

  // codesign -dv reports on stderr, not stdout.
  const info = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
  const details = `${info.stderr || ''}${info.stdout || ''}`;
  const flags = (details.match(/flags=\S+/) || ['flags=?'])[0];
  const identifier = (details.match(/Identifier=\S+/) || ['Identifier=?'])[0];
  console.log(`  • signature verified — ${identifier} ${flags}`);
};
