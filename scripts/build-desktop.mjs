import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The desktop build requires macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'dist', 'MKV to MP4.app');
const contents = join(app, 'Contents');
const resources = join(contents, 'Resources');
const bin = join(resources, 'bin');
if (!existsSync('/opt/homebrew/bin/ffmpeg') && !existsSync('/usr/local/bin/ffmpeg')) throw new Error('Install FFmpeg with brew install ffmpeg first.');
rmSync(app, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
mkdirSync(join(contents, 'MacOS'), { recursive: true });
cpSync(join(root, 'desktop/Info.plist'), join(contents, 'Info.plist'));
cpSync(join(root, 'public'), join(resources, 'public'), { recursive: true });
cpSync(join(root, 'server.mjs'), join(resources, 'server-core.mjs'));
cpSync(join(root, 'desktop/server.mjs'), join(resources, 'server.mjs'));
cpSync(process.execPath, join(bin, 'node'));
const nodeLicense = join(dirname(dirname(process.execPath)), 'LICENSE');
if (!existsSync(nodeLicense)) throw new Error('Node.js LICENSE is required when bundling its runtime.');
mkdirSync(join(resources, 'licenses'), { recursive: true });
cpSync(nodeLicense, join(resources, 'licenses/Node-LICENSE.txt'));
const cache = join(root, 'dist/swift-cache');
mkdirSync(cache, { recursive: true });
execFileSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-module-cache-path', cache, '-framework', 'Cocoa', '-framework', 'WebKit', join(root, 'desktop/App.swift'), '-o', join(contents, 'MacOS/MKVConverter')], { stdio: 'inherit' });
const iconset = join(root, 'dist/AppIcon.iconset');
mkdirSync(iconset, { recursive: true });
const iconTool = join(root, 'dist/draw-icon');
const icon = join(root, 'dist/icon.png');
execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache, join(root, 'desktop/Icon.swift'), '-o', iconTool], { stdio: 'inherit' });
execFileSync(iconTool, [icon]);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
  }
}
// ICNS supports PNG representations directly; write the standard chunk container.
const representations = [['icp4', 'icon_16x16.png'], ['icp5', 'icon_32x32.png'], ['icp6', 'icon_32x32@2x.png'], ['ic07', 'icon_128x128.png'], ['ic08', 'icon_256x256.png'], ['ic09', 'icon_512x512.png'], ['ic10', 'icon_512x512@2x.png']];
const chunks = representations.map(([type, name]) => {
  const png = readFileSync(join(iconset, name));
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const iconHeader = Buffer.alloc(8);
iconHeader.write('icns', 0, 4, 'ascii');
iconHeader.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
writeFileSync(join(resources, 'AppIcon.icns'), Buffer.concat([iconHeader, ...chunks]));
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
console.log(`Built ${app}`);
console.log('Double-click the app in Finder. It can be moved independently of the project.');
