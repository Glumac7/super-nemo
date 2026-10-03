#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runOnce, runDaemon, retry, status, acknowledge } from './linear.mjs';
import { installLaunchd, uninstallLaunchd } from './linear-launchd.mjs';

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv[0] === 'acknowledge') {
    if (argv.length !== 6 || argv[1] !== '--config' || argv[3] !== '--issue' || argv[5] !== '--confirm-stopped') throw new Error('Usage: acknowledge --config <absolute path> --issue <UUID> --confirm-stopped (ALL poller/child processes must already be stopped)');
    return acknowledge(argv[2], argv[4], true, deps);
  }
  if (argv.length !== 3 || argv[1] !== '--config' || !['run', 'once', 'status', 'retry', 'install', 'uninstall'].includes(argv[0])) throw new Error('Usage: node lib/linear-cli.mjs <run|once|status|retry|install|uninstall> --config <absolute path>');
  const [command, , configPath] = argv;
  if (command === 'install') return installLaunchd(configPath);
  if (command === 'uninstall') return uninstallLaunchd(configPath);
  if (command === 'status') return status(configPath);
  if (command === 'retry') return retry(configPath, deps);
  if (command === 'run') return runDaemon(configPath, { onError: message => console.error(message), ...deps });
  return runOnce(configPath, deps);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => {
    if (typeof result === 'string') console.log(result);
    else console.log(JSON.stringify(result, null, 2));
  }).catch(() => { console.error('Linear automation failed; check configuration, private state and control-plane lock. No credential or remote error details are printed.'); process.exitCode = 1; });
}
