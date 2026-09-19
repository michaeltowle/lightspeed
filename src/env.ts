export interface Env {
  ANTHROPIC_API_KEY: string;
  LIGHTSPEED_APP_RECORDS: D1Database;
  // Injected at deploy time by the `deploy` npm script (see package.json).
  // Absent under `wrangler dev`, which renders the badge as "local dev".
  DEPLOY_BRANCH?: string;
  DEPLOYED_AT?: string;
}
