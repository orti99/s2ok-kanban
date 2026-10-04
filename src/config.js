import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  behindProxy: env.BEHIND_PROXY === '1' || env.BEHIND_PROXY === 'true',
  githubToken: env.GITHUB_TOKEN || null,
  sessionTtlMs: 1000 * 60 * 60 * 24 * 14, // 14 days
};
