/** A repository on github.com or on a GitHub Enterprise server. */
export interface RepoRef {
  /** Host name, lower case: `github.com`, `github.acme.com`, `acme.ghe.com`. */
  host: string;
  owner: string;
  repo: string;
}

/**
 * Reads owner and repository out of a git remote URL in any of the forms git
 * accepts: https, ssh://, scp-like `git@host:owner/repo`, with or without `.git`.
 */
export function parseRemote(url: string): RepoRef | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    return undefined;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  // `ssh.github.com` is GitHub's ssh-over-443 endpoint.
  host = host.toLowerCase().replace(/^ssh\.github\.com$/, 'github.com');
  return { host, owner: parts[0], repo: parts[1] };
}

export function isDotCom(host: string): boolean {
  return host === 'github.com' || host === 'www.github.com';
}

/**
 * The REST API root for a host: api.github.com, `api.<name>.ghe.com` for
 * GitHub Enterprise Cloud with data residency, `/api/v3` on a server.
 */
export function apiBase(host: string): string {
  if (isDotCom(host)) {
    return 'https://api.github.com';
  }
  if (host.endsWith('.ghe.com')) {
    return `https://api.${host}`;
  }
  return `https://${host}/api/v3`;
}

export function webBase(host: string): string {
  return isDotCom(host) ? 'https://github.com' : `https://${host}`;
}

/**
 * Picks the GitHub remote to follow: the branch's upstream, then `origin`,
 * then `upstream`, then any remote on a host we can talk to.
 */
export function pickRemote(
  remotes: Array<{ name: string; url: string }>,
  preferredName: string | undefined,
  enterpriseHost: string | undefined
): RepoRef | undefined {
  const usable = (url: string): RepoRef | undefined => {
    const ref = parseRemote(url);
    if (!ref) {
      return undefined;
    }
    return isDotCom(ref.host) || ref.host.endsWith('.ghe.com') || ref.host === enterpriseHost ? ref : undefined;
  };
  const order = [preferredName, 'origin', 'upstream'];
  for (const name of order) {
    const remote = remotes.find((candidate) => candidate.name === name);
    const ref = remote && usable(remote.url);
    if (ref) {
      return ref;
    }
  }
  for (const remote of remotes) {
    const ref = usable(remote.url);
    if (ref) {
      return ref;
    }
  }
  return undefined;
}

/** The host part of VS Code's `github-enterprise.uri` setting. */
export function enterpriseHostOf(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    return new URL(/^https?:\/\//i.test(uri) ? uri : `https://${uri}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
