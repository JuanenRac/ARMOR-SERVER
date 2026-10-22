# Contributing to ARMOR-SERVER

1. **Before a pull request** run `python -I tools/armor_ci_validate.py` and the tests of the project: both must pass.
2. **The README exists in eight languages** (`README.md` and `README_spa.md`, `README_fra.md`, `README_ita.md`, `README_deu.md`, `README_zho.md`, `README_jpn.md`, `README_por.md`). They are generated from the sources in ARMOR-DOCS, so a change to the text is made there and the eight files are regenerated.
3. **Texts that people read** (panels, messages, help) exist in eight languages: English, Spanish, French, Italian, German, Chinese, Japanese and European Portuguese.
4. **A change to a message between components** starts in ARMOR-COMMON, which defines every message once, and comes with accepted and rejected examples.
5. **Firmware is built and checked** before it is published; do not describe as working on a board what has only been built.
6. Commits are written in English, small and about one thing. No secrets in the repository.
