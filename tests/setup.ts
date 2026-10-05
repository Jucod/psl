import { testDatabaseUrl } from './test-database.js';

// Runs in every test worker, before any module reads the environment.
// The database itself is prepared once by tests/global-setup.ts.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.PSL_ALLOW_FIXTURES = '1';
// Forced, not defaulted: a developer's .env pointing at a paid provider must
// never turn `npm test` into billed API calls.
process.env.PSL_EMBEDDING_PROVIDER = 'local';
process.env.PSL_LLM_PROVIDER = 'local';
