#!/usr/bin/env python3
"""
Per-field error-rate bench.

The brief is explicit: "The per-field error rate must be measured and
displayed; it is a deliverable in itself." This is what is shown to the
client, not the assumed quality of the extraction.

Four outcomes per field, deliberately kept apart:
  exact     - the extracted value is the one collected by hand;
  divergent - a value was extracted, but it is wrong. This is the serious
              case: wrong data costs more than missing data;
  missing   - nothing was extracted although there was something;
  spurious  - something was extracted although there was nothing.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

FIELDS = [
    "appellation_id", "name", "color", "vintage", "abv",
    "blend", "aging", "price_eur", "certification", "tasting_note",
]


def normalize(field: str, value):
    if value is None:
        return None
    if field == "blend":
        if not value:
            return None
        return tuple(sorted((a["grape"], a.get("pct")) for a in value))
    if isinstance(value, str):
        return " ".join(value.split())
    return value


def compare(expected, extracted) -> str:
    if expected is None and extracted is None:
        return "exact"
    if expected is None:
        return "spurious"
    if extracted is None:
        return "missing"
    return "exact" if expected == extracted else "divergent"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected", type=Path, default=Path(__file__).parent / "expected")
    ap.add_argument("--output", type=Path, default=Path(__file__).parent / "output")
    ap.add_argument("--threshold", type=float, default=0.25,
                    help="overall error rate above which the command fails")
    args = ap.parse_args()

    sheets = sorted(p.stem for p in args.expected.glob("*.json"))
    if not sheets:
        print("no reference sheet")
        return 1

    results: dict[str, dict[str, int]] = {
        f: {"exact": 0, "divergent": 0, "missing": 0, "spurious": 0} for f in FIELDS
    }
    details: list[tuple[str, str, str, object, object]] = []

    for sheet in sheets:
        expected = json.loads((args.expected / f"{sheet}.json").read_text(encoding="utf8"))
        extracted_path = args.output / f"{sheet}.json"
        extracted = json.loads(extracted_path.read_text(encoding="utf8")) if extracted_path.exists() else {}

        for field in FIELDS:
            a = normalize(field, expected.get(field))
            e = normalize(field, extracted.get(field))
            outcome = compare(a, e)
            results[field][outcome] += 1
            if outcome != "exact":
                details.append((sheet, field, outcome, a, e))

    n = len(sheets)
    width = max(len(f) for f in FIELDS)

    print(f"\nError rate per field  ({n} sheet(s) checked by hand)\n")
    print(f"{'field'.ljust(width)}  exact  diverg.  miss.  spur.     error rate")
    print("-" * (width + 46))

    total_errors = 0
    for field in FIELDS:
        r = results[field]
        errors = r["divergent"] + r["missing"] + r["spurious"]
        total_errors += errors
        rate = errors / n
        bar = "#" * round(rate * 20)
        print(f"{field.ljust(width)}  {r['exact']:5}  {r['divergent']:7}  "
              f"{r['missing']:5}  {r['spurious']:5}     {rate:6.0%} {bar}")

    overall = total_errors / (n * len(FIELDS))
    print("-" * (width + 46))
    print(f"{'OVERALL'.ljust(width)}  {' ' * 28}{overall:6.0%}\n")

    if details:
        print("Discrepancies\n")
        for sheet, field, outcome, a, e in details:
            print(f"  {sheet} · {field} · {outcome}")
            print(f"      expected  : {str(a)[:100]}")
            print(f"      extracted : {str(e)[:100]}")

    print(f"\nAcceptance threshold: {args.threshold:.0%}")
    if overall > args.threshold:
        print(f"FAILED: {overall:.0%} > {args.threshold:.0%}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
