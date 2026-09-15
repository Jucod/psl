#!/usr/bin/env python3
"""
Jalon 5 : fiche technique PDF -> JSON conforme a db/schema/cuvee.schema.json.

Perimetre, a tenir : ce script ne connait ni Postgres, ni les embeddings, ni
l'API. Il lit un PDF et ecrit un JSON. C'est ce qui garde le cout du choix
"Node pour le runtime, Python pour l'extraction" a un seul fichier.

Garde-fou central, et raison d'etre de la fonction `verbatim` : tout champ
textuel extrait doit se retrouver LITTERALEMENT dans la couche texte du PDF.
C'est le seul endroit du pipeline ou une hallucination passerait inaperçue,
que l'extraction soit faite par regles (ici) ou plus tard par un modele vision.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber
from jsonschema import Draft202012Validator

RACINE = Path(__file__).resolve().parent.parent
SCHEMA = RACINE / "db" / "schema" / "cuvee.schema.json"

CEPAGES = {
    "syrah": ["syrah", "shiraz"],
    "grenache": ["grenache noir", "grenache n", "grenache"],
    "mourvedre": ["mourvedre", "monastrell"],
    "cinsaut": ["cinsaut", "cinsault"],
    "carignan": ["carignan"],
    "counoise": ["counoise"],
    "morrastel": ["morrastel"],
    "grenache-gris": ["grenache gris"],
}

COULEURS = {"rouge": ["rouge"], "rose": ["rose"], "blanc": ["blanc"]}


def sans_accents(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn").lower()


def espaces(t: str) -> str:
    return re.sub(r"\s+", " ", t).strip()


@dataclass
class Rapport:
    """Ce que l'extraction a su faire, et ce qu'elle a refuse de faire."""
    champs_extraits: list[str] = field(default_factory=list)
    champs_absents: list[str] = field(default_factory=list)
    rejets_verbatim: list[str] = field(default_factory=list)
    erreurs_schema: list[str] = field(default_factory=list)


class Extracteur:
    def __init__(self, chemin: Path):
        self.chemin = chemin
        with pdfplumber.open(chemin) as pdf:
            pages = [p.extract_text() or "" for p in pdf.pages]
        self.texte = "\n".join(pages)
        self.plat = espaces(self.texte)
        self.plat_sa = sans_accents(self.plat)
        self.rapport = Rapport()

    # --- garde-fou ---------------------------------------------------------
    def verbatim(self, valeur: str | None, champ: str) -> str | None:
        """
        Refuse toute valeur textuelle absente de la couche texte du PDF.
        Un champ rejete vaut None : on prefere un trou a une invention.
        """
        if valeur is None:
            return None
        if sans_accents(espaces(valeur)) in self.plat_sa:
            return valeur
        self.rapport.rejets_verbatim.append(f"{champ}: {valeur[:60]!r}")
        return None

    # --- champs ------------------------------------------------------------
    def appellation(self) -> str | None:
        # "AOC X", "AOP X", et la tournure en prose "en appellation X".
        m = (re.search(r"\b(?:AOC|AOP)\s+([A-Za-zÀ-ÿ' -]{3,40})", self.plat)
             or re.search(r"\bappellation\s+([A-Z][A-Za-zÀ-ÿ' -]{3,40})", self.plat))
        if not m:
            return None
        nom = espaces(m.group(1))
        # Coupe sur les separateurs qui suivent frequemment le nom.
        nom = re.split(r"\s+(?:—|–|-|\||Millesime|Millésime|Couleur)\b", nom)[0]
        return "aoc-" + re.sub(r"[^a-z0-9]+", "-", sans_accents(nom)).strip("-")

    def nom_cuvee(self) -> str | None:
        # La premiere ligne non vide qui n'est ni le domaine ni une etiquette.
        for ligne in (l.strip() for l in self.texte.splitlines()):
            if not ligne or len(ligne) > 60:
                continue
            bas = sans_accents(ligne)
            if any(bas.startswith(p) for p in ("domaine", "mas ", "chateau", "aop", "aoc", "fiche")):
                continue
            return espaces(re.split(r"\s+[—–]\s+", ligne)[0])
        return None

    def millesime(self) -> int | None:
        annees = [int(a) for a in re.findall(r"\b(19[5-9]\d|20[0-4]\d)\b", self.plat)]
        return max(annees) if annees else None

    def couleur(self) -> str | None:
        for code, termes in COULEURS.items():
            if any(re.search(rf"\b{t}\b", self.plat_sa) for t in termes):
                return code
        return None

    def degre(self) -> float | None:
        m = re.search(r"(\d{1,2})[.,](\d)\s*%\s*vol|\b(\d{1,2})\s*%\s*vol", self.plat_sa)
        if not m:
            return None
        if m.group(3):
            return float(m.group(3))
        return float(f"{m.group(1)}.{m.group(2)}")

    def assemblage(self) -> list[dict]:
        trouve: dict[str, float | None] = {}
        for code, synonymes in CEPAGES.items():
            for syn in synonymes:
                # "70 % Syrah" ou "Syrah 70 %", avec ou sans espace avant le %.
                for motif in (
                    rf"(\d{{1,3}})\s*%\s*(?:de\s+)?{syn}\b",
                    rf"\b{syn}\s*:?\s*(\d{{1,3}})\s*%",
                ):
                    m = re.search(motif, self.plat_sa)
                    if m:
                        trouve.setdefault(code, float(m.group(1)))
                        break
                if code in trouve:
                    break
                if re.search(rf"\b{syn}\b", self.plat_sa):
                    trouve.setdefault(code, None)
                    break
        return [{"cepage": c, "pct": p} for c, p in trouve.items()]

    def elevage(self) -> str | None:
        m = re.search(
            r"(?:elevage|vieillissement)\s*:?\s*(?:de\s+|d'\s*)?(.{5,160}?)"
            r"(?:\.|\n|Rendement|Certification|Prix)",
            sans_accents(self.texte), re.IGNORECASE | re.DOTALL,
        )
        if not m:
            return None
        # Retrouve le segment d'origine, accents compris, par position.
        debut, fin = m.span(1)
        return self.verbatim(espaces(self.texte[debut:fin]), "elevage")

    # Un pied de page n'est pas une note de degustation. Marqueurs frequents :
    # separateur typographique, code postal, mention "fiche technique".
    PIED = r"(?:[·•]|\b\d{5}\b|fiche technique)"

    def note_degustation(self) -> str | None:
        m = re.search(
            rf"(?:degustation|ce que nous y trouvons|commentaire)\s*:?\s*\n?(.{{40,900}}?)"
            rf"(?:\n\s*(?:accords?|a table|prix|contact)\b|\n[^\n]*{self.PIED}|\Z)",
            sans_accents(self.texte), re.IGNORECASE | re.DOTALL,
        )
        if not m:
            return None
        debut, fin = m.span(1)
        return self.verbatim(espaces(self.texte[debut:fin]), "note_degustation")

    def prix(self) -> float | None:
        m = re.search(r"(\d{1,3})[.,](\d{2})\s*(?:€|eur)", self.plat_sa)
        if m:
            return float(f"{m.group(1)}.{m.group(2)}")
        m = re.search(r"\b(\d{1,3})\s*(?:€|eur)\b", self.plat_sa)
        return float(m.group(1)) if m else None

    def certification(self) -> str | None:
        if re.search(r"agriculture biologique|\bbio\b|\bAB\b", self.plat_sa):
            return "Agriculture biologique"
        return None

    # --- assemblage du document -------------------------------------------
    def extraire(self, domaine_id: str, source_url: str, date_releve: str) -> dict:
        note = self.note_degustation()
        prix = self.prix()
        appellation = self.appellation()
        nom = self.nom_cuvee()
        millesime = self.millesime()

        identifiant = "-".join(
            filter(None, [domaine_id, re.sub(r"[^a-z0-9]+", "-", sans_accents(nom or "cuvee")).strip("-"),
                          str(millesime) if millesime else None])
        )

        doc = {
            "id": identifiant,
            "domaine_id": domaine_id,
            "appellation_id": appellation,
            "nom_cuvee": nom,
            "couleur": self.couleur(),
            "millesime": millesime,
            "assemblage": self.assemblage(),
            "degre": self.degre(),
            "elevage": self.elevage(),
            "prix_ttc": prix,
            # Invariant du schema: un prix exige sa date de releve.
            "prix_date_releve": date_releve if prix is not None else None,
            "bio": True if self.certification() else None,
            "certification": self.certification(),
            "note_degustation": note,
            # Invariant du schema: une note exige sa source.
            "note_degustation_source": {
                "id": f"fiche-{domaine_id}",
                "type": "fiche_technique",
                "label": f"Fiche technique {domaine_id}",
                "url": source_url,
                "date_releve": date_releve,
            } if note else None,
            "accords_producteur": [],
            "fiche_url": source_url,
        }

        for cle, valeur in doc.items():
            vide = valeur is None or (isinstance(valeur, list) and not valeur)
            (self.rapport.champs_absents if vide else self.rapport.champs_extraits).append(cle)

        return doc


def valider(doc: dict, rapport: Rapport) -> bool:
    schema = json.loads(SCHEMA.read_text(encoding="utf8"))
    validateur = Draft202012Validator(schema)
    erreurs = sorted(validateur.iter_errors(doc), key=lambda e: list(e.path))
    for e in erreurs:
        rapport.erreurs_schema.append(f"{'.'.join(map(str, e.path)) or '(racine)'}: {e.message}")
    return not erreurs


def main() -> int:
    ap = argparse.ArgumentParser(description="Fiche technique PDF -> JSON conforme")
    ap.add_argument("pdf", nargs="+", type=Path)
    ap.add_argument("--sortie", type=Path, required=True)
    ap.add_argument("--date-releve", default="2026-09-15")
    ap.add_argument("--url-base", default="https://example.invalid/fiches")
    args = ap.parse_args()

    args.sortie.mkdir(parents=True, exist_ok=True)
    code = 0

    for chemin in args.pdf:
        domaine = chemin.stem
        ex = Extracteur(chemin)
        doc = ex.extraire(domaine, f"{args.url_base}/{chemin.name}", args.date_releve)
        conforme = valider(doc, ex.rapport)

        (args.sortie / f"{domaine}.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )

        etat = "conforme" if conforme else "NON CONFORME"
        print(f"{chemin.name:28} {etat:14} "
              f"{len(ex.rapport.champs_extraits)} champs, {len(ex.rapport.champs_absents)} vides")
        for r in ex.rapport.rejets_verbatim:
            print(f"    rejet verbatim : {r}")
        for e in ex.rapport.erreurs_schema:
            print(f"    schema : {e}")
        if not conforme:
            code = 1

    return code


if __name__ == "__main__":
    sys.exit(main())
