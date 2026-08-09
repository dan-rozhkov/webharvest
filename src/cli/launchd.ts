export const LABEL = 'dev.webharvest.daemon';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistContents(opts: {
  nodePath: string;
  daemonPath: string;
  logPath: string;
  port: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.nodePath)}</string>
    <string>${esc(opts.daemonPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WEBHARVEST_PORT</key>
    <string>${opts.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(opts.logPath)}</string>
</dict>
</plist>
`;
}
