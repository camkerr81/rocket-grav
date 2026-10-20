"""
CLI implementation for braille-icon.
"""

import sys
import os
import argparse
from braille_icon.catalog import ICONS
from braille_icon import get_icon, replace_emojis, audit_text
from braille_icon.matrix import render_ascii_blueprint


def cmd_list(args):
    print("⣏⣿ Master Braille Icon Catalog (55 Icons):")
    print("─" * 72)
    print(f" {'4x4':<6} {'2x4':<5} {'Legacy':<10} {'Role / Concept'}")
    print("─" * 72)
    for icon in ICONS:
        em_str = " ".join(icon.emojis[:2])
        print(f"  {icon.primary:<5} {icon.compact:<5} {em_str:<10} {icon.name}")


def cmd_lookup(args):
    query = args.query.strip()
    icon = get_icon(query)

    if not icon:
        # Partial match fallback
        matches = [i for i in ICONS if query.lower() in i.name.lower()]
        if not matches:
            print(f"No Braille icon found matching '{args.query}'.", file=sys.stderr)
            sys.exit(1)
        for m in matches:
            print(f"{m.primary} (compact: {m.compact})  =>  {m.name}  [{' '.join(m.emojis)}]")
            if args.blueprint:
                print(render_ascii_blueprint(m.primary))
                print()
        return

    print(f"{icon.primary} (compact: {icon.compact})  =>  {icon.name}  [{' '.join(icon.emojis)}]")
    print(f"Category: {icon.category}")
    print(f"Heading Syntax: {icon.heading_example}")
    print(f"Menu Item Syntax: {icon.menu_example}")

    if args.blueprint:
        print("\nDot Matrix Blueprint:")
        print(render_ascii_blueprint(icon.primary))


def cmd_replace(args):
    filepath = args.file
    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    new_content, count = replace_emojis(content)

    if count > 0:
        if not args.dry_run:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Successfully replaced {count} legacy emojis in {filepath}")
        else:
            print(f"[Dry Run] Found {count} emojis to replace in {filepath}")
    else:
        print(f"Clean! No legacy emojis detected in {filepath}")


def cmd_check(args):
    filepath = args.file
    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    violations = audit_text(content, ignore_code=getattr(args, "ignore_code", False))

    if violations:
        print(f"Found {len(violations)} legacy emoji violations in {filepath}:")
        for line_num, em, braille, text in violations:
            print(f"  L{line_num}: '{em}' -> recommended: '{braille}' | {text[:60]}")
        sys.exit(1)
    else:
        print(f"Pass: Zero legacy emojis detected in {filepath}")


def main():
    parser = argparse.ArgumentParser(
        prog="braille-icon",
        description="Tactile Monospace Braille Icon Standard & Tooling"
    )
    subparsers = parser.add_subparsers(dest="subcommand")

    p_list = subparsers.add_parser("list", help="List all approved Braille icons")
    
    p_lookup = subparsers.add_parser("lookup", help="Look up a Braille icon by name or emoji")
    p_lookup.add_argument("query", help="Search keyword or emoji")
    p_lookup.add_argument("-b", "--blueprint", action="store_true", help="Show ASCII dot blueprint")

    p_replace = subparsers.add_parser("replace", help="Replace legacy emojis with Braille icons in a file")
    p_replace.add_argument("file", help="File to process")
    p_replace.add_argument("--dry-run", action="store_true", help="Preview changes without writing")

    p_check = subparsers.add_parser("check", help="Check a file for legacy emoji violations")
    p_check.add_argument("file", help="File to inspect")
    p_check.add_argument("--ignore-code", action="store_true", help="Ignore emojis inside code fences and backticks")

    args = parser.parse_args()
    if args.subcommand == "list" or not args.subcommand:
        cmd_list(args)
    elif args.subcommand == "lookup":
        cmd_lookup(args)
    elif args.subcommand == "replace":
        cmd_replace(args)
    elif args.subcommand == "check":
        cmd_check(args)


if __name__ == "__main__":
    main()
