import { normaliser } from '../config/lexique.js';

/**
 * Detection d'instructions dans une note de degustation, a l'INGESTION.
 *
 * Le vrai vecteur d'injection de ce systeme n'est pas l'utilisateur - sa
 * demande n'atteint jamais le prompt de formulation - c'est le CORPUS. Une
 * fiche technique est du texte tiers, et au jalon 5 elle arrivera d'un PDF
 * telecharge sur un site qu'on ne controle pas.
 *
 * Pourquoi ici et pas en ligne: l'ingestion est hors ligne, rare et supervisee.
 * Un faux positif y coute trente secondes de relecture humaine. En ligne, il
 * couterait une reponse degradee a un visiteur. C'est le seul filtre
 * heuristique que ce projet s'autorise, et il est place la ou se tromper est
 * bon marche.
 *
 * La note n'est pas rejetee: elle est mise en QUARANTAINE, c'est-a-dire
 * signalee pour relecture. Un domaine qui ecrit "laissez-vous tenter" n'a rien
 * fait de mal.
 */

const MOTIFS: { nom: string; motif: RegExp }[] = [
  { nom: 'adresse a un systeme', motif: /\b(ignore|ignorez|oublie|oubliez)\b[^.]{0,40}\b(consigne|instruction|regle|precedent)/i },
  { nom: 'assignation de role', motif: /\btu es\b|\bvous etes\b[^.]{0,30}\b(assistant|sommelier|modele|ia)\b/i },
  { nom: 'vocabulaire de prompt', motif: /\b(system prompt|prompt|instruction system|<\|)/i },
  { nom: 'injonction de reponse', motif: /\b(reponds|repondez|ecris|ecrivez|affiche|affichez)\b[^.]{0,30}\b(que|uniquement|plutot|a la place)\b/i },
  { nom: 'balise technique', motif: /<\/?\s*(system|assistant|user|instruction)\s*>/i },
];

export interface Quarantaine {
  cuvee_id: string;
  motifs: string[];
  extrait: string;
}

export function inspecterNote(cuveeId: string, note: string | null): Quarantaine | null {
  if (!note) return null;
  const plat = normaliser(note);
  const motifs = MOTIFS.filter((m) => m.motif.test(plat)).map((m) => m.nom);
  if (motifs.length === 0) return null;
  return { cuvee_id: cuveeId, motifs, extrait: note.slice(0, 120) };
}
