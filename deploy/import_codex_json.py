#!/usr/bin/env python3
"""Import Codex/OpenAI token JSON files into Sub2API.

The script reads one or more JSON files, sends their raw content to Sub2API's
admin codex-session import endpoint, and prints only import summaries. It does
not echo token contents.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:8080"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Batch import Codex/OpenAI token JSON files into Sub2API.",
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="JSON files or directories containing .json files.",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SUB2API_BASE_URL", DEFAULT_BASE_URL),
        help=f"Sub2API base URL. Default: env SUB2API_BASE_URL or {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--admin-key",
        default=os.environ.get("SUB2API_ADMIN_API_KEY", ""),
        help="Sub2API Admin API Key. Default: env SUB2API_ADMIN_API_KEY.",
    )
    parser.add_argument(
        "--group-ids",
        default=os.environ.get("SUB2API_GROUP_IDS", ""),
        help="Comma-separated target group IDs, for example: 2,4.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=10,
        help="Account concurrency value used for imported accounts. Default: 10.",
    )
    parser.add_argument(
        "--priority",
        type=int,
        default=1,
        help="Account priority value used for imported accounts. Default: 1.",
    )
    parser.add_argument(
        "--rate-multiplier",
        type=float,
        default=1.0,
        help="Account rate multiplier. Default: 1.0.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="Number of files to send per request. Default: 100.",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Recursively scan directories for .json files.",
    )
    parser.add_argument(
        "--no-update-existing",
        action="store_true",
        help="Do not update existing accounts matched by identity.",
    )
    parser.add_argument(
        "--skip-default-group-bind",
        action="store_true",
        help="Pass skip_default_group_bind=true to the import endpoint.",
    )
    parser.add_argument(
        "--confirm-mixed-channel-risk",
        action="store_true",
        help="Confirm mixed-channel risk when importing into mixed groups.",
    )
    parser.add_argument(
        "--credential-extras",
        default="",
        help="JSON object merged into account credentials.",
    )
    parser.add_argument(
        "--extra",
        default="",
        help="JSON object merged into account extra metadata.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification for HTTPS base URLs.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only scan and validate JSON files; do not call Sub2API.",
    )
    parser.add_argument(
        "--save-result",
        default="",
        help="Optional path to write the full import result JSON.",
    )
    return parser.parse_args()


def collect_json_files(raw_paths: list[str], recursive: bool) -> list[Path]:
    files: list[Path] = []
    for raw in raw_paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            pattern = "**/*.json" if recursive else "*.json"
            files.extend(sorted(p for p in path.glob(pattern) if p.is_file()))
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f"Path not found: {path}")
    unique: dict[str, Path] = {}
    for file_path in files:
        unique[str(file_path.resolve())] = file_path
    return [unique[key] for key in sorted(unique)]


def parse_group_ids(raw: str) -> list[int]:
    if not raw.strip():
        return []
    values: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            values.append(int(part))
        except ValueError as exc:
            raise SystemExit(f"Invalid group id: {part}") from exc
    return values


def parse_json_object(raw: str, label: str) -> dict[str, Any] | None:
    if not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} must be valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"{label} must be a JSON object")
    return value


def validate_and_read(file_paths: list[Path]) -> list[tuple[Path, str]]:
    entries: list[tuple[Path, str]] = []
    for file_path in file_paths:
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = file_path.read_text(encoding="utf-8-sig")
        trimmed = content.strip()
        if not trimmed:
            raise SystemExit(f"Empty JSON file: {file_path}")
        try:
            json.loads(trimmed)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSON in {file_path}: {exc}") from exc
        entries.append((file_path, trimmed))
    return entries


def api_root(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if not base:
        raise SystemExit("Sub2API base URL is empty")
    parsed = urllib.parse.urlsplit(base)
    marker = "/api/v1"
    if marker in parsed.path:
        prefix = parsed.path.split(marker, 1)[0] + marker
        parsed = parsed._replace(path=prefix.rstrip("/"), query="", fragment="")
        return urllib.parse.urlunsplit(parsed).rstrip("/")
    return base + marker


def request_json(
    url: str,
    admin_key: str,
    payload: dict[str, Any],
    insecure: bool,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-api-key": admin_key,
        },
    )
    context = None
    if insecure and url.lower().startswith("https://"):
        context = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=120, context=context) as resp:
            data = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        data = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Sub2API HTTP {exc.code}: {data[:1000]}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Failed to connect to Sub2API: {exc}") from exc
    try:
        result = json.loads(data)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Sub2API returned non-JSON response: {data[:1000]}") from exc
    if not isinstance(result, dict):
        raise SystemExit("Sub2API returned an unexpected JSON value")
    return result


def chunks(values: list[tuple[Path, str]], size: int) -> list[list[tuple[Path, str]]]:
    if size <= 0:
        raise SystemExit("--batch-size must be greater than 0")
    return [values[index : index + size] for index in range(0, len(values), size)]


def compact_payload(args: argparse.Namespace, contents: list[str]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contents": contents,
        "concurrency": args.concurrency,
        "priority": args.priority,
        "rate_multiplier": args.rate_multiplier,
        "update_existing": not args.no_update_existing,
    }
    group_ids = parse_group_ids(args.group_ids)
    if group_ids:
        payload["group_ids"] = group_ids
    if args.skip_default_group_bind:
        payload["skip_default_group_bind"] = True
    if args.confirm_mixed_channel_risk:
        payload["confirm_mixed_channel_risk"] = True
    credential_extras = parse_json_object(args.credential_extras, "--credential-extras")
    if credential_extras:
        payload["credential_extras"] = credential_extras
    extra = parse_json_object(args.extra, "--extra")
    if extra:
        payload["extra"] = extra
    return payload


def merge_result(total: dict[str, Any], batch_result: dict[str, Any]) -> None:
    for key in ("total", "created", "updated", "skipped", "failed"):
        total[key] = int(total.get(key, 0)) + int(batch_result.get(key, 0) or 0)
    for key in ("items", "warnings", "errors"):
        values = batch_result.get(key)
        if isinstance(values, list):
            total.setdefault(key, []).extend(values)


def main() -> int:
    args = parse_args()
    file_paths = collect_json_files(args.paths, args.recursive)
    if not file_paths:
        print("No JSON files found.", file=sys.stderr)
        return 1

    entries = validate_and_read(file_paths)
    print(f"Found {len(entries)} JSON file(s).")
    for file_path, _ in entries[:10]:
        print(f"  - {file_path}")
    if len(entries) > 10:
        print(f"  ... and {len(entries) - 10} more")

    if args.dry_run:
        print("Dry run complete. No data was imported.")
        return 0

    if not args.admin_key.strip():
        print(
            "Missing admin key. Set SUB2API_ADMIN_API_KEY or pass --admin-key.",
            file=sys.stderr,
        )
        return 1

    endpoint = api_root(args.base_url) + "/admin/accounts/import/codex-session"
    aggregate: dict[str, Any] = {"total": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}
    batches = chunks(entries, args.batch_size)
    for index, batch in enumerate(batches, start=1):
        payload = compact_payload(args, [content for _, content in batch])
        print(f"Importing batch {index}/{len(batches)} ({len(batch)} file(s))...")
        result = request_json(endpoint, args.admin_key.strip(), payload, args.insecure)
        merge_result(aggregate, result)
        print(
            "  result: "
            f"created={result.get('created', 0)}, "
            f"updated={result.get('updated', 0)}, "
            f"skipped={result.get('skipped', 0)}, "
            f"failed={result.get('failed', 0)}"
        )

    print(
        "Import complete: "
        f"total={aggregate['total']}, "
        f"created={aggregate['created']}, "
        f"updated={aggregate['updated']}, "
        f"skipped={aggregate['skipped']}, "
        f"failed={aggregate['failed']}"
    )
    errors = aggregate.get("errors")
    if isinstance(errors, list) and errors:
        print("Errors:")
        for item in errors[:20]:
            if isinstance(item, dict):
                print(
                    f"  #{item.get('index', '-')}: "
                    f"{item.get('name') or '-'} - {item.get('message') or '-'}"
                )
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more")

    if args.save_result:
        output_path = Path(args.save_result).expanduser()
        output_path.write_text(
            json.dumps(aggregate, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Full result written to {output_path}")

    return 1 if int(aggregate.get("failed", 0) or 0) > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
