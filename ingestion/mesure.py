#!/usr/bin/env python3
"""
Banc de mesure du taux d'erreur par champ.

Le brief est explicite : « Le taux d'erreur par champ doit etre mesure et
affiche, c'est un livrable en soi. » C'est ce qu'on montre au client, pas la
qualite supposee de l'extraction.

Quatre issues par champ, volontairement distinguees :
  exact     - la valeur extraite est celle relevee a la main ;
  divergent - une valeur a ete extraite, mais fausse. C'est le cas grave :
              une donnee fausse coute plus cher qu'une donnee absente ;
  manquant  - rien n'a ete extrait alors qu'il y avait quelque chose ;
  superflu  - quelque chose a ete extrait alors qu'il n'y avait rien.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

CHAMPS = [
    "appellation_id", "nom_cuvee", "couleur", "millesime", "degre",
    "assemblage", "elevage", "prix_ttc", "certification", "note_degustation",
]


def normaliser(champ: str, valeur):
    if valeur is None:
        return None
    if champ == "assemblage":
        if not valeur:
            return None
        return tuple(sorted((a["cepage"], a.get("pct")) for a in valeur))
    if isinstance(valeur, str):
        return " ".join(valeur.split())
    return valeur


def comparer(attendu, extrait) -> str:
    if attendu is None and extrait is None:
        return "exact"
    if attendu is None:
        return "superflu"
    if extrait is None:
        return "manquant"
    return "exact" if attendu == extrait else "divergent"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--attendu", type=Path, default=Path(__file__).parent / "attendu")
    ap.add_argument("--sortie", type=Path, default=Path(__file__).parent / "sortie")
    ap.add_argument("--seuil", type=float, default=0.25,
                    help="taux d'erreur global au-dela duquel la commande echoue")
    args = ap.parse_args()

    fiches = sorted(p.stem for p in args.attendu.glob("*.json"))
    if not fiches:
        print("aucune fiche de reference")
        return 1

    resultats: dict[str, dict[str, int]] = {
        c: {"exact": 0, "divergent": 0, "manquant": 0, "superflu": 0} for c in CHAMPS
    }
    details: list[tuple[str, str, str, object, object]] = []

    for fiche in fiches:
        attendu = json.loads((args.attendu / f"{fiche}.json").read_text(encoding="utf8"))
        chemin_extrait = args.sortie / f"{fiche}.json"
        extrait = json.loads(chemin_extrait.read_text(encoding="utf8")) if chemin_extrait.exists() else {}

        for champ in CHAMPS:
            a = normaliser(champ, attendu.get(champ))
            e = normaliser(champ, extrait.get(champ))
            issue = comparer(a, e)
            resultats[champ][issue] += 1
            if issue != "exact":
                details.append((fiche, champ, issue, a, e))

    n = len(fiches)
    largeur = max(len(c) for c in CHAMPS)

    print(f"\nTaux d'erreur par champ  ({n} fiche(s) relue(s) a la main)\n")
    print(f"{'champ'.ljust(largeur)}  exact  diverg.  manq.  superf.   taux d'erreur")
    print("-" * (largeur + 46))

    total_erreurs = 0
    for champ in CHAMPS:
        r = resultats[champ]
        erreurs = r["divergent"] + r["manquant"] + r["superflu"]
        total_erreurs += erreurs
        taux = erreurs / n
        barre = "#" * round(taux * 20)
        print(f"{champ.ljust(largeur)}  {r['exact']:5}  {r['divergent']:7}  "
              f"{r['manquant']:5}  {r['superflu']:7}   {taux:6.0%} {barre}")

    global_ = total_erreurs / (n * len(CHAMPS))
    print("-" * (largeur + 46))
    print(f"{'GLOBAL'.ljust(largeur)}  {' ' * 28}{global_:6.0%}\n")

    if details:
        print("Detail des ecarts\n")
        for fiche, champ, issue, a, e in details:
            print(f"  {fiche} · {champ} · {issue}")
            print(f"      attendu : {str(a)[:100]}")
            print(f"      extrait : {str(e)[:100]}")

    print(f"\nSeuil d'acceptation : {args.seuil:.0%}")
    if global_ > args.seuil:
        print(f"ECHEC : {global_:.0%} > {args.seuil:.0%}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
