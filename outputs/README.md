# Outputs

Generated and issued Safe Method artifacts live under this folder.

- `issued/<project-slug>/` is for controlled issued outputs and their handoff
  manifests. These files are tracked in Git.
- `tmp/` and `local/` are for verification scratch and local experiments. They
  are ignored and may be deleted at any time.
- Draft outputs may be kept in a named project folder when they are part of the
  audit record. Otherwise, use `tmp/`.

Do not use the current clock for filename date stamps. Use no date stamp, an
explicit `YYYY-MM-DD`, or a stamp derived from the project issue date.
