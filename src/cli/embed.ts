import { db, closeDb } from '../db/client.js';
import { config } from '../config/domain.js';
import { embeddingProvider } from '../embeddings/index.js';
import { embedCatalog } from '../embeddings/refresh.js';

const provider = embeddingProvider();
console.log(`embeddings: provider "${provider.name}", ${config.embeddingDimension} dims`);

const summary = await embedCatalog(db(), provider);
console.log(`  appellation profiles      : ${summary.profiles}`);
console.log(`  wines with a note         : ${summary.winesWithNote}`);
console.log(`  wines on the AOC profile  : ${summary.winesOnAppellationProfile}`);
console.log(`  signature                 : ${summary.signature}`);

await closeDb();
