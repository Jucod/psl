#!/usr/bin/env python3
"""
Milestone 5: PDF tech sheet -> JSON matching db/schema/wine.schema.json.

Scope, to be held: this script knows neither Postgres, nor embeddings, nor
the API. It reads a PDF and writes a JSON. That is what keeps the cost of the
"Node for the runtime, Python for extraction" choice down to a single file.

Central guardrail, and the reason the `verbatim` function exists: every
extracted text field must be found LITERALLY in the PDF's text layer. It is
the only place in the pipeline where a hallucination would go unnoticed,
whether extraction is rule-based (here) or later done by a vision model.

The sheets are French, so are the patterns below.
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

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "db" / "schema" / "wine.schema.json"

GRAPES = {
    "syrah": ["syrah", "shiraz"],
    "grenache": ["grenache noir", "grenache n", "grenache"],
    "mourvedre": ["mourvedre", "monastrell"],
    "cinsaut": ["cinsaut", "cinsault"],
    "carignan": ["carignan"],
    "counoise": ["counoise"],
    "morrastel": ["morrastel"],
    "grenache-gris": ["grenache gris"],
}

COLORS = {"red": ["rouge"], "rose": ["rose"], "white": ["blanc"]}


def strip_accents(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn").lower()


def squash(t: str) -> str:
    return re.sub(r"\s+", " ", t).strip()


@dataclass
class Report:
    """What the extraction managed to do, and what it refused to do."""
    extracted_fields: list[str] = field(default_factory=list)
    missing_fields: list[str] = field(default_factory=list)
    verbatim_rejections: list[str] = field(default_factory=list)
    schema_errors: list[str] = field(default_factory=list)


class Extractor:
    def __init__(self, path: Path):
        self.path = path
        with pdfplumber.open(path) as pdf:
            pages = [p.extract_text() or "" for p in pdf.pages]
        self.text = "\n".join(pages)
        self.flat = squash(self.text)
        self.flat_na = strip_accents(self.flat)
        self.report = Report()

    # --- guardrail ---------------------------------------------------------
    def verbatim(self, value: str | None, field_name: str) -> str | None:
        """
        Rejects any text value absent from the PDF's text layer.
        A rejected field is None: a gap is better than an invention.
        """
        if value is None:
            return None
        if strip_accents(squash(value)) in self.flat_na:
            return value
        self.report.verbatim_rejections.append(f"{field_name}: {value[:60]!r}")
        return None

    # --- fields ------------------------------------------------------------
    def appellation(self) -> str | None:
        # "AOC X", "AOP X", and the prose form "en appellation X".
        m = (re.search(r"\b(?:AOC|AOP)\s+([A-Za-zÀ-ÿ' -]{3,40})", self.flat)
             or re.search(r"\bappellation\s+([A-Z][A-Za-zÀ-ÿ' -]{3,40})", self.flat))
        if not m:
            return None
        name = squash(m.group(1))
        # Cut on the separators that often follow the name.
        name = re.split(r"\s+(?:—|–|-|\||Millesime|Millésime|Couleur)\b", name)[0]
        return "aoc-" + re.sub(r"[^a-z0-9]+", "-", strip_accents(name)).strip("-")

    def name(self) -> str | None:
        # The first non-empty line that is neither the estate nor a label.
        for line in (l.strip() for l in self.text.splitlines()):
            if not line or len(line) > 60:
                continue
            low = strip_accents(line)
            if any(low.startswith(p) for p in ("domaine", "mas ", "chateau", "aop", "aoc", "fiche")):
                continue
            return squash(re.split(r"\s+[—–]\s+", line)[0])
        return None

    def vintage(self) -> int | None:
        years = [int(a) for a in re.findall(r"\b(19[5-9]\d|20[0-4]\d)\b", self.flat)]
        return max(years) if years else None

    def color(self) -> str | None:
        for code, terms in COLORS.items():
            if any(re.search(rf"\b{t}\b", self.flat_na) for t in terms):
                return code
        return None

    def abv(self) -> float | None:
        m = re.search(r"(\d{1,2})[.,](\d)\s*%\s*vol|\b(\d{1,2})\s*%\s*vol", self.flat_na)
        if not m:
            return None
        if m.group(3):
            return float(m.group(3))
        return float(f"{m.group(1)}.{m.group(2)}")

    def blend(self) -> list[dict]:
        found: dict[str, float | None] = {}
        for code, synonyms in GRAPES.items():
            for syn in synonyms:
                # "70 % Syrah" or "Syrah 70 %", with or without a space before the %.
                for pattern in (
                    rf"(\d{{1,3}})\s*%\s*(?:de\s+)?{syn}\b",
                    rf"\b{syn}\s*:?\s*(\d{{1,3}})\s*%",
                ):
                    m = re.search(pattern, self.flat_na)
                    if m:
                        found.setdefault(code, float(m.group(1)))
                        break
                if code in found:
                    break
                if re.search(rf"\b{syn}\b", self.flat_na):
                    found.setdefault(code, None)
                    break
        return [{"grape": c, "pct": p} for c, p in found.items()]

    def aging(self) -> str | None:
        m = re.search(
            r"(?:elevage|vieillissement)\s*:?\s*(?:de\s+|d'\s*)?(.{5,160}?)"
            r"(?:\.|\n|Rendement|Certification|Prix)",
            strip_accents(self.text), re.IGNORECASE | re.DOTALL,
        )
        if not m:
            return None
        # Recover the original segment, accents included, by position.
        start, end = m.span(1)
        return self.verbatim(squash(self.text[start:end]), "aging")

    # A page footer is not a tasting note. Common markers: typographic
    # separator, postal code, the words "fiche technique".
    FOOTER = r"(?:[·•]|\b\d{5}\b|fiche technique)"

    def tasting_note(self) -> str | None:
        m = re.search(
            rf"(?:degustation|ce que nous y trouvons|commentaire)\s*:?\s*\n?(.{{40,900}}?)"
            rf"(?:\n\s*(?:accords?|a table|prix|contact)\b|\n[^\n]*{self.FOOTER}|\Z)",
            strip_accents(self.text), re.IGNORECASE | re.DOTALL,
        )
        if not m:
            return None
        start, end = m.span(1)
        return self.verbatim(squash(self.text[start:end]), "tasting_note")

    def price(self) -> float | None:
        m = re.search(r"(\d{1,3})[.,](\d{2})\s*(?:€|eur)", self.flat_na)
        if m:
            return float(f"{m.group(1)}.{m.group(2)}")
        m = re.search(r"\b(\d{1,3})\s*(?:€|eur)\b", self.flat_na)
        return float(m.group(1)) if m else None

    def certification(self) -> str | None:
        if re.search(r"agriculture biologique|\bbio\b|\bAB\b", self.flat_na):
            return "Agriculture biologique"
        return None

    # --- document assembly -------------------------------------------------
    def extract(self, producer_id: str, source_url: str, retrieved_on: str) -> dict:
        note = self.tasting_note()
        price = self.price()
        appellation = self.appellation()
        name = self.name()
        vintage = self.vintage()

        identifier = "-".join(
            filter(None, [producer_id, re.sub(r"[^a-z0-9]+", "-", strip_accents(name or "cuvee")).strip("-"),
                          str(vintage) if vintage else None])
        )

        doc = {
            "id": identifier,
            "producer_id": producer_id,
            "appellation_id": appellation,
            "name": name,
            "color": self.color(),
            "vintage": vintage,
            "blend": self.blend(),
            "abv": self.abv(),
            "aging": self.aging(),
            "price_eur": price,
            # Schema invariant: a price requires the date it was observed.
            "price_as_of": retrieved_on if price is not None else None,
            "organic": True if self.certification() else None,
            "certification": self.certification(),
            "tasting_note": note,
            # Schema invariant: a note requires its source.
            "tasting_note_source": {
                "id": f"sheet-{producer_id}",
                "type": "tech_sheet",
                "label": f"Fiche technique {producer_id}",
                "url": source_url,
                "retrieved_on": retrieved_on,
            } if note else None,
            "producer_pairings": [],
            "page_url": source_url,
        }

        for key, value in doc.items():
            empty = value is None or (isinstance(value, list) and not value)
            (self.report.missing_fields if empty else self.report.extracted_fields).append(key)

        return doc


def validate(doc: dict, report: Report) -> bool:
    schema = json.loads(SCHEMA.read_text(encoding="utf8"))
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
    for e in errors:
        report.schema_errors.append(f"{'.'.join(map(str, e.path)) or '(root)'}: {e.message}")
    return not errors


def main() -> int:
    ap = argparse.ArgumentParser(description="PDF tech sheet -> schema-conformant JSON")
    ap.add_argument("pdf", nargs="+", type=Path)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--retrieved-on", default="2026-09-15")
    ap.add_argument("--base-url", default="https://example.invalid/sheets")
    args = ap.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    code = 0

    for path in args.pdf:
        producer = path.stem
        ex = Extractor(path)
        doc = ex.extract(producer, f"{args.base_url}/{path.name}", args.retrieved_on)
        valid = validate(doc, ex.report)

        (args.output / f"{producer}.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )

        state = "valid" if valid else "INVALID"
        print(f"{path.name:28} {state:14} "
              f"{len(ex.report.extracted_fields)} fields, {len(ex.report.missing_fields)} empty")
        for r in ex.report.verbatim_rejections:
            print(f"    verbatim rejection : {r}")
        for e in ex.report.schema_errors:
            print(f"    schema : {e}")
        if not valid:
            code = 1

    return code


if __name__ == "__main__":
    sys.exit(main())
