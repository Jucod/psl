import { fermer } from '../db/client.js';
import { executerPipeline } from '../pipeline.js';
import { filtresActifs } from '../schema/filtres.js';

const message = process.argv.slice(2).join(' ');
if (!message) {
  console.error('usage: npm run demo -- "un rouge pas trop tannique pour un gigot, autour de 20 euros"');
  process.exit(1);
}

const sortie = await executerPipeline({ message });

console.log('\n\x1b[2m> ' + message + '\x1b[0m\n');
console.log(sortie.texte);
console.log('\n\x1b[2m---\x1b[0m');
console.log('\x1b[2mstatut         :\x1b[0m', sortie.statut);
console.log('\x1b[2mprovider LLM   :\x1b[0m', sortie.providerLlm + (sortie.degrade ? ` (DEGRADE: ${sortie.raisonDegrade})` : ''));
console.log('\x1b[2mclassement     :\x1b[0m', sortie.recherche?.classement ?? '-');
if (sortie.recherche) {
  const f = sortie.recherche.filtresAppliques;
  console.log('\x1b[2mfiltres actifs :\x1b[0m', filtresActifs(f).map((c) => `${c}=${JSON.stringify((f as any)[c])}`).join('  '));
  if (sortie.recherche.relachements.length) {
    console.log('\x1b[2melargissements :\x1b[0m', sortie.recherche.relachements.map((r) => r.annonce).join(' | '));
  }
}
console.log('\x1b[2mlatence        :\x1b[0m', sortie.latence_ms + ' ms');
console.log('\x1b[2mcout           :\x1b[0m', sortie.usage.cout_eur.toFixed(6) + ' EUR');

await fermer();
