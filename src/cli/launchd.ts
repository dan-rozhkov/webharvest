export const LABEL = 'dev.webharvest.daemon';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistContents(opts: {
  nodePath: string;
  daemonPath: string;
  logPath: string;
  port: number;
  /** launchd agents do NOT inherit the shell environment, unlike the manual
   *  `webharvest start` spawn path (which passes `env: process.env`
   *  through). Without threading this in, a user who exported
   *  BRAVE_API_KEY, ran `install`, and whose SearXNG happens to be down
   *  gets "no provider answered" with no hint that their configured
   *  fallback was never actually passed to the daemon. Omitted from the
   *  plist entirely when unset — never written as an empty <string/>. */
  braveApiKey?: string | null;
}): string {
  const envEntries = [`    <key>WEBHARVEST_PORT</key>\n    <string>${opts.port}</string>`];
  if (opts.braveApiKey) {
    envEntries.push(`    <key>BRAVE_API_KEY</key>\n    <string>${esc(opts.braveApiKey)}</string>`);
  }
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
${envEntries.join('\n')}
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
