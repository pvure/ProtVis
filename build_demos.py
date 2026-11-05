"""Precompute the demo proteins into web/demos/ so the page works with no server."""

import csv
import glob
import json
from collections import Counter
from pathlib import Path

import protvis

DEMOS = {
    "ubiquitin": ("Ubiquitin", "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG"),
    "gb1": ("Protein G B1", "MTYKLILNGKTLKGETTTEAVDAATAEKVFKQYANDNGVDGEWTYDDATKTFTVTE"),
    "avgfp": ("avGFP", "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTFSYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK"),
}


def ascas12f():
    """Wild type = per-position consensus of the single-mutant DMS library."""
    path = glob.glob(str(Path.home() / ".cache/huggingface/hub/datasets--SaProtHub--Dataset-AsCas12f/snapshots/*/dataset.csv"))
    if not path:
        return None
    rows = [r["protein"] for r in csv.DictReader(open(path[0]))]
    L = Counter(map(len, rows)).most_common(1)[0][0]
    rows = [r for r in rows if len(r) == L]
    return "".join(Counter(col).most_common(1)[0][0] for col in zip(*rows))


if __name__ == "__main__":
    out = Path(__file__).parent / "web" / "demos"
    out.mkdir(parents=True, exist_ok=True)
    s = ascas12f()
    if s:
        DEMOS["ascas12f"] = ("AsCas12f", s)
    index = []
    for key, (name, seq) in DEMOS.items():
        r = protvis.embed(seq)
        r["name"] = name
        (out / f"{key}.json").write_text(json.dumps(r, separators=(",", ":")))
        index.append({"key": key, "name": name, "length": len(seq)})
        print(f"{name:14s} L={len(seq):4d}  pppl={r['pseudo_ppl']:.2f}  contacts={len(r['contacts'])}")
    (out / "index.json").write_text(json.dumps(index))
