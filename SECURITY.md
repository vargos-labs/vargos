# Security Policy

## Supported Versions

Only the latest release receives security updates.

## Reporting a Vulnerability

Vargos handles API keys, auth tokens, and personal data. If you discover a security issue, please report it responsibly:

1. **Do not** open a public issue.
2. Use [GitHub Security Advisories](https://github.com/vargos-labs/vargos/security/advisories/new) to file a private report.
3. Include steps to reproduce if possible.
4. We will respond within 48 hours.

## What We Consider Security Issues

- API key leakage in logs or error messages
- Authentication bypass in gateway or channels
- Path traversal in file operations
- Remote code execution via webhooks or MCP
- Credential exposure in config or sessions
- Whitelist (`channel.allowFrom`) bypass — sending agent commands as a non-allowed user
- Persona file (`~/.vargos/agents/<id>.md`) injection that bypasses configured `allowedTools`

## What Is Not a Security Issue

- Dependency vulnerabilities (open a regular issue instead)
- Denial of service via rate limiting (this is expected behavior)
- Social engineering attacks against the user
