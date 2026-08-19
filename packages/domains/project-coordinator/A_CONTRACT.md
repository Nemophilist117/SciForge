# A contract pin

- Commit: `e7829276e34422a95133a6e1c5a602d79c0d79ed`
- Official contracts tgz SHA-256: `4a838d173637022bee7b53a1e3d9b2bdf4017ac741302d10d7b4771bde16b22c`

The A package is not copied into this B/C-only branch. Isolated verification uses
the locally available 41-blob A contract source snapshot. An ordinary `npm pack`
of that snapshot hashes to
`c9675cf48e6482ba178e0836bbfb42e3f4273cd595dc7daf22fa896f0dfd35f3`,
so it is not accepted as a substitute for the official release artifact.

Formal packed-artifact integration remains blocked until the official tgz is
available. B must verify the file against the pinned SHA before consuming it.
