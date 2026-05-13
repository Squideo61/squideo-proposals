#!/usr/bin/env node
// PreToolUse hook: prints `*** <command>` to stderr when Claude is about to
// run a Bash command that the project's allowlist silently auto-approves.
// Keeps the user aware of what's running without their per-call approval.
//
// Patterns must stay in sync with .claude/settings.json `permissions.allow`.

let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(buf);
    if (input.tool_name !== 'Bash') return;
    const cmd = input?.tool_input?.command;
    if (typeof cmd !== 'string') return;
    const head = cmd.split('\n')[0].trim();

    const allowlisted = [
      /^npm\s+view\b/,
      /^npm\s+test(\s|$)/,
      /^npm\s+run\s+build(\s|$)/,
      /^npm\s+outdated(\s|$)/,
    ];

    if (allowlisted.some((re) => re.test(head))) {
      process.stderr.write(`*** ${head}\n`);
    }
  } catch {
    // Swallow parsing errors — never block a tool call from a hook bug.
  }
});