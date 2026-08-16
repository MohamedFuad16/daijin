#!/usr/bin/env python3
# CORRECTION 2026-08-16 (leader, after verifier report 1): the header prose below
# says "unicode61 (no stemming)"; the code is authoritative and creates
# tokenize='porter unicode61', which DOES stem. The stopword list is a
# hand-written 30-word approximation of Postgres 'english', not snowball.
# This file is a preserved measurement instrument with the owner's absolute
# paths; it is evidence, not product code. The normative recipe lives in
# README.md and engine/src/store/store.d.ts.
# FTS5 vs Postgres ts_rank: the lexical arm only, measured on the real corpus.
#
# Question: if the lexical arm moves from Postgres 'english' tsvector (stemming,
# camelCase collapse) to SQLite FTS5 unicode61 (no stemming), do the gold set's
# must_return documents still surface, especially the identifier cases the arm
# exists for?
#
# Scope bound, stated up front: this measures the LEXICAL ARM IN ISOLATION.
# No embeddings, no RRF fusion, no rescale, no slot allocation. A lexical miss
# here is not an end-to-end miss (the semantic arm may still carry the case);
# a lexical hit here is necessary for FTS5 to contribute what ts_rank contributes.
#
# Method: same 732 chunks, same queries. PG side runs the production lexical SQL
# shape (websearch_to_tsquery('english', q), ts_rank over content_tsv, top 40).
# FTS5 side indexes the same chunk content under unicode61 and runs the query as
# quoted whitespace tokens joined by implicit AND (the closest faithful
# translation of websearch_to_tsquery's AND-of-terms with phrase-safe hyphens),
# ranked by bm25, top 40. Hit = any chunk of a must_return document in top 40.
import csv
import io
import json
import sqlite3
import subprocess
import sys

import yaml

REPO = "/Users/mfuad16/Documents/Codex/2026-07-21/hand-ai-brain-build-instructions-md/ai-brain-platform"
GOLDSET = f"{REPO}/ai-brain/projects/internship-portal/retrieval-goldset.yaml"
DB_URL_KEY = "DATABASE_URL"
TOP_K = 40


def database_url():
    with open(f"{REPO}/.env.local", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith(f"{DB_URL_KEY}="):
                return line.strip().split("=", 1)[1]
    raise SystemExit("DATABASE_URL not found in .env.local")


def psql(url, sql):
    result = subprocess.run(
        ["psql", url, "-At", "-F", "\t", "-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise SystemExit(f"psql failed: {result.stderr.strip()}\nSQL: {sql[:200]}")
    return result.stdout


def load_chunks(url):
    # CSV round-trip so multi-line content survives.
    result = subprocess.run(
        ["psql", url, "-c",
         "COPY (SELECT c.id, c.document, c.content FROM chunk c) TO STDOUT WITH CSV"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise SystemExit(f"chunk copy failed: {result.stderr.strip()}")
    rows = list(csv.reader(io.StringIO(result.stdout)))
    return [(row[0], row[1], row[2]) for row in rows]


STOPWORDS = set("""a an and are as at be by for from has have how i in is it its of on or
should that the this to was what when where which who why will with must does do not
""".split())


def fts5_query(query):
    # Postgres 'english' drops stopwords before matching; a faithful FTS5 adapter
    # must too, or strict AND demands literal 'how'/'should' inside the chunk.
    tokens = [t.replace('"', '""') for t in query.split() if t.lower() not in STOPWORDS]
    if not tokens:
        tokens = [t.replace('"', '""') for t in query.split()]
    return " ".join(f'"{t}"' for t in tokens)


def pg_lexical_ranks(url, query):
    quoted = query.replace("'", "''")
    sql = (
        "SELECT c.document FROM websearch_to_tsquery('english', '" + quoted + "') AS q, "
        "chunk AS c WHERE c.content_tsv @@ q "
        "ORDER BY ts_rank(c.content_tsv, q) DESC, c.id LIMIT " + str(TOP_K)
    )
    docs = []
    for line in psql(url, sql).splitlines():
        if line and line not in docs:
            docs.append(line)
    return docs


def fts5_lexical_ranks(connection, query):
    match = fts5_query(query)
    try:
        rows = connection.execute(
            "SELECT document FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?",
            (match, TOP_K),
        ).fetchall()
    except sqlite3.OperationalError as error:
        return {"error": str(error)}
    docs = []
    for (document,) in rows:
        if document not in docs:
            docs.append(document)
    return docs


def main():
    url = database_url()
    chunks = load_chunks(url)
    print(f"chunks loaded: {len(chunks)}", file=sys.stderr)

    connection = sqlite3.connect(":memory:")
    connection.execute(
        "CREATE VIRTUAL TABLE chunks USING fts5(document UNINDEXED, content, tokenize='porter unicode61')"
    )
    connection.executemany(
        "INSERT INTO chunks (document, content) VALUES (?, ?)",
        [(document, content) for _, document, content in chunks],
    )

    with open(GOLDSET, encoding="utf-8") as handle:
        cases = yaml.safe_load(handle)

    report = []
    for case in cases:
        query = case["query"]
        must = case["must_return"]
        pg_docs = pg_lexical_ranks(url, query)
        ft_docs = fts5_lexical_ranks(connection, query)
        ft_error = isinstance(ft_docs, dict)

        def best_rank(docs):
            ranks = [docs.index(doc) + 1 for doc in must if doc in docs]
            return min(ranks) if ranks else None

        pg_rank = best_rank(pg_docs)
        ft_rank = None if ft_error else best_rank(ft_docs)
        report.append({
            "id": case["id"],
            "identifier": bool(case.get("identifier")),
            "query": query,
            "pg_hit": pg_rank is not None,
            "pg_best_rank": pg_rank,
            "pg_candidates": len(pg_docs),
            "fts5_hit": ft_rank is not None,
            "fts5_best_rank": ft_rank,
            "fts5_candidates": 0 if ft_error else len(ft_docs),
            "fts5_error": ft_docs.get("error") if ft_error else None,
        })

    identifiers = [row for row in report if row["identifier"]]
    everything = report

    def summary(rows, label):
        pg = sum(1 for row in rows if row["pg_hit"])
        ft = sum(1 for row in rows if row["fts5_hit"])
        print(f"{label}: n={len(rows)}  pg_hits={pg}  fts5_hits={ft}")

    print("== lexical-arm-only comparison, top", TOP_K, "==")
    summary(identifiers, "identifier cases")
    summary(everything, "all cases")
    print()
    print(f"{'case':6} {'ident':5} {'pg':>4} {'fts5':>4}  query")
    for row in report:
        pg_cell = str(row["pg_best_rank"]) if row["pg_hit"] else ("-" if row["pg_candidates"] else "0c")
        ft_cell = (
            "ERR" if row["fts5_error"]
            else str(row["fts5_best_rank"]) if row["fts5_hit"]
            else ("-" if row["fts5_candidates"] else "0c")
        )
        marker = " <-- diverges" if row["pg_hit"] != row["fts5_hit"] else ""
        print(f"{row['id']:6} {str(row['identifier']):5} {pg_cell:>4} {ft_cell:>4}  {row['query'][:70]}{marker}")
    print()
    print("legend: number = best rank of a must_return doc; '-' = candidates but no hit; '0c' = zero candidates; ERR = FTS5 query error")

    with open(f"{REPO}/../fts5-report.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)


if __name__ == "__main__":
    main()
