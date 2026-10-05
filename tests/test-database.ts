import { env } from '../src/config/env.js';

/**
 * The tests own their database: `<name>_test` next to the development one,
 * or PSL_TEST_DATABASE_URL when set. It is reset and reseeded on every run,
 * so the suite never depends on how the developer last seeded their own
 * database (with or without fixtures, with an old schema...).
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.PSL_TEST_DATABASE_URL;
  const url = new URL(explicit || env.databaseUrl());
  if (!explicit) {
    const name = decodeURIComponent(url.pathname.slice(1)) || 'psl';
    if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  }
  return url.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
