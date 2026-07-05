# Project Instructions

## Medical Accuracy

- Do not assume pediatric cardiology facts are correct from memory.
- Verify medical content against reputable sources before creating or changing cases, ECG teaching, treatment steps, scoring rationale, or explanations.
- Prefer primary or authoritative sources when available: AHA/AAP guidelines, AAP publications, peer-reviewed reviews, established pediatric cardiology texts already present on this machine, and major hospital/academic references.
- If using a local source from this computer, record the file path in the case reference metadata or implementation notes.
- If using an internet source, record the source URL in case reference metadata when the source supports in-app content.
- Synthetic ECGs must be labeled as synthetic educational ECGs unless a licensed/allowed real tracing is used.
- Do not present the app as clinical decision support. It is educational prototype content unless reviewed and approved by a qualified clinician.

## Verification

- Run `npm run typecheck`, `npm test`, and `npm run lint` before calling implementation complete.
- For visible UI changes, inspect the app in the browser and confirm the rendered screen matches the intended behavior.
- For medical-content changes, add or update tests that enforce references and prevent placeholder content from passing unnoticed.
